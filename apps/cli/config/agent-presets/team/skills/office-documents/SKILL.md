---
name: office-documents
description: Read, convert, or extract text from office documents — PDF, Word (.docx), Excel (.xlsx/.csv), PowerPoint (.pptx), and EPUB — into Markdown for analysis, search, or summarization. Use this skill whenever the user asks to inspect a document, spreadsheet, slide deck, or book and the file is not already plain text.
---

# Read Office Documents

Convert a document into Markdown, then read the Markdown with the ordinary text tools. Never dump raw binary into the conversation; always convert first.

## Choose a path

| Format | Preferred tool | Fallback |
| --- | --- | --- |
| PDF | `markitdown` (Python, MIT) | `pdftotext` (poppler) or `pypdf` |
| Word `.docx` | `markitdown` | `python-docx` |
| Excel `.xlsx` | `markitdown` | `openpyxl` or read `.csv` directly |
| PowerPoint `.pptx` | `markitdown` | `python-pptx` |
| EPUB | `markitdown` | unzip + read the XHTML |
| CSV / JSON / XML | read directly | — |

`markitdown` is the Microsoft open-source (MIT) one-shot converter: it preserves headings, lists, tables, and links as Markdown, which the model reads most efficiently. Prefer it; only fall back to the per-format library when a specific field or layout is needed.

## Convert with markitdown

Install once per environment (a user-level or venv install, never a repo change):

```sh
python -m pip install --user markitdown
```

Convert one file to a `.md` file:

```sh
python -m markitdown path/to/file.pdf -o path/to/file.md
```

Or to stdout for a quick peek:

```sh
python -m markitdown path/to/file.xlsx
```

On Windows, the shell tool is `pwsh`; the same commands run under PowerShell. If `python` is not on PATH, try `python3` or `py`.

## Read the result

After conversion, read the `.md` file with the filesystem tool. For large documents, read in chunks and summarize section by section. Do not try to hold an entire book in one message.

## Constraints

- Do not `cat`/`read` a binary document as text — the output is unreadable and wastes the context window.
- Do not modify the source document; write the Markdown output beside it (`<name>.md`) unless the user says otherwise.
- A conversion failure is usually a missing dependency, not a corrupt file: run the matching `pip install` for the format, then retry.
- For a protected or scanned PDF without a text layer, markitdown/pdftotext yield nothing; say so and offer OCR only if the user confirms.
