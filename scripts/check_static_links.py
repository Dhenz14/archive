#!/usr/bin/env python3
"""Fail when local HTML href targets point at missing files."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
HREF_RE = re.compile(r"""href\s*=\s*["']([^"']+)["']""")


def is_local_html_link(href: str) -> bool:
    href = href.strip()
    if not href or href.startswith(("#", "{", "${")):
        return False
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", href):
        return False
    return urlsplit(href).path.endswith(".html")


def target_exists(source: Path, href: str) -> bool:
    path = unquote(urlsplit(href).path)
    target = (source.parent / path).resolve()
    try:
        target.relative_to(ROOT)
    except ValueError:
        return False
    return target.is_file()


def main() -> int:
    failures: list[str] = []
    for source in sorted(ROOT.glob("*.html")):
        text = source.read_text(encoding="utf-8")
        for match in HREF_RE.finditer(text):
            href = match.group(1)
            if is_local_html_link(href) and not target_exists(source, href):
                failures.append(f"{source.relative_to(ROOT)}: missing local href target: {href}")

    if failures:
        print("[static-links] FAIL")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print("[static-links] PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
