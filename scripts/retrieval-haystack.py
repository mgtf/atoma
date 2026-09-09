"""Experimental host subprocess. stdin: admitted passages/queries; stdout: IDs/scores only."""
import contextlib
import json
import os
import sys
import hashlib
import platform
import queue
import threading
from importlib.metadata import distributions

os.environ["HAYSTACK_TELEMETRY_ENABLED"] = "False"
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"


def runtime_identity():
    identity = {"python": platform.python_version(), "packages": sorted(
        (d.metadata["Name"], d.version) for d in distributions())}
    encoded = json.dumps(identity, separators=(",", ":"), ensure_ascii=True)
    return {"identity": identity, "sha256": hashlib.sha256(encoded.encode()).hexdigest()}


def input_lines():
    # Observe EOF even while native model work is busy: a killed host cannot orphan us.
    requests = queue.Queue(maxsize=9)
    def read():
        for line in sys.stdin.buffer:
            requests.put(line)
        os._exit(0)
    threading.Thread(target=read, daemon=True).start()
    while True:
        yield requests.get()


def main():
    lines = input_lines()
    from haystack import Document, Pipeline, __version__
    from haystack.components.retrievers.in_memory import InMemoryBM25Retriever, InMemoryEmbeddingRetriever
    from haystack.components.joiners import DocumentJoiner
    from haystack.document_stores.in_memory import InMemoryDocumentStore

    output = sys.stdout
    store = None
    pipeline = None
    mode = None
    # Redirect all dependency chatter; the protocol channel has one writer.
    with contextlib.redirect_stdout(sys.stderr):
        for line in lines:
            request = json.loads(line)
            request_id = request["id"]
            try:
                if request["op"] == "init" and pipeline is None:
                    settings = request["settings"]
                    mode = settings["mode"]
                    documents = [Document(id=d["id"], content=d["content"]) for d in request["documents"]]
                    store = InMemoryDocumentStore(shared=False, bm25_algorithm="BM25Okapi", embedding_similarity_function="cosine")
                    pipeline = Pipeline()
                    pipeline.add_component("bm25", InMemoryBM25Retriever(store))
                    if mode == "hybrid-rerank":
                        import torch
                        from haystack.utils import ComponentDevice
                        torch.set_num_threads(1)
                        from haystack_integrations.components.embedders.sentence_transformers import (
                            SentenceTransformersDocumentEmbedder, SentenceTransformersTextEmbedder,
                        )
                        from haystack_integrations.components.rankers.sentence_transformers import SentenceTransformersSimilarityRanker
                        for key in ("embeddingPath", "rerankerPath"):
                            if not os.path.isabs(settings[key]) or not os.path.isdir(settings[key]):
                                raise ValueError("model files are not provisioned locally")
                        embedder = SentenceTransformersDocumentEmbedder(model=settings["embeddingPath"], progress_bar=False,
                                                                         device=ComponentDevice.from_str("cpu"),
                                                                         local_files_only=True, trust_remote_code=False)
                        embedder.warm_up()
                        documents = embedder.run(documents)["documents"]
                        query_embedder = SentenceTransformersTextEmbedder(model=settings["embeddingPath"], progress_bar=False,
                                                                         device=ComponentDevice.from_str("cpu"), prefix=settings["queryPrefix"],
                                                                         local_files_only=True, trust_remote_code=False)
                        query_embedder.warm_up()
                        ranker = SentenceTransformersSimilarityRanker(model=settings["rerankerPath"],
                                                                     device=ComponentDevice.from_str("cpu"), trust_remote_code=False)
                        ranker.warm_up()
                        pipeline.add_component("embed", query_embedder)
                        pipeline.add_component("dense", InMemoryEmbeddingRetriever(store))
                        pipeline.add_component("fusion", DocumentJoiner(join_mode="reciprocal_rank_fusion"))
                        pipeline.add_component("ranker", ranker)
                        pipeline.connect("embed.embedding", "dense.query_embedding")
                        pipeline.connect("bm25.documents", "fusion.documents")
                        pipeline.connect("dense.documents", "fusion.documents")
                        pipeline.connect("fusion.documents", "ranker.documents")
                    elif mode != "bm25":
                        raise ValueError("unsupported mode")
                    store.write_documents(documents)
                    response = {"kind": "ready", "id": request_id, "version": __version__, "documents": len(documents), "runtimeSha256": runtime_identity()["sha256"]}
                elif request["op"] == "search" and pipeline is not None:
                    query, limit = request["query"], request["limit"]
                    inputs = {"bm25": {"query": query, "top_k": limit}}
                    target = "bm25"
                    if mode == "hybrid-rerank":
                        inputs.update({"embed": {"text": query}, "dense": {"top_k": limit},
                                       "fusion": {"top_k": limit}, "ranker": {"query": query, "top_k": limit}})
                        target = "ranker"
                    documents = pipeline.run(inputs)[target]["documents"]
                    response = {"kind": "result", "id": request_id,
                                "hits": [{"id": d.id, "score": d.score} for d in documents]}
                else:
                    raise ValueError("unsupported operation")
                output.write(json.dumps(response, allow_nan=False) + "\n")
                output.flush()
            except Exception:
                output.write(json.dumps({"kind": "error", "id": request_id}) + "\n")
                output.flush()
                break
    if store is not None:
        store.shutdown()


if __name__ == "__main__":
    if sys.argv[1:] == ["--identity"]:
        print(json.dumps(runtime_identity()))
    else:
        main()
