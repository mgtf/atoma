# Synthetic retrieval documents

These fixtures contain only invented pricing/support text. Modern files were
created using python-docx, openpyxl, python-pptx and ReportLab; LibreOffice
converted them to DOC/XLS/PPT and ODT/ODS/ODP. The RTF is authored directly.
Tests parse the real files in the production extraction subprocess. Legacy
conversion tests require `soffice` on PATH; all modern-format tests always run.
