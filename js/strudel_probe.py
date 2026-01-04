#!/usr/bin/env python3
"""Strudel probe helper.

Standalone script (separate from launch/LSP) that attaches to an existing
Chromium instance (ideally the one Strudel is running in) and executes small
JavaScript snippets to inspect runtime globals like `soundMap`.

It uses CDP via pychrome, so you can run it without manual devtools clicking.

Usage:
  python js/strudel_probe.py list
  python js/strudel_probe.py soundmap
  python js/strudel_probe.py eval "Object.keys(window).slice(0,10)"

By default it connects to http://127.0.0.1:9222. Start Chromium with:
  chromium --remote-debugging-port=9222
or ensure your Puppeteer/launch uses that flag.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, Optional


def eprint(*args: Any) -> None:
    print(*args, file=sys.stderr)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(add_help=True)
    p.add_argument(
        "--host",
        default="127.0.0.1",
        help="Remote debugging host (default: 127.0.0.1)",
    )
    p.add_argument(
        "--port",
        type=int,
        default=9222,
        help="Remote debugging port (default: 9222)",
    )
    p.add_argument(
        "--tab",
        default=None,
        help="Tab match substring (URL/title). If omitted, first tab is used.",
    )

    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="List available tabs")

    sub.add_parser("globals", help="List global keys matching sound/sample")

    sub.add_parser("soundmap", help="Inspect window.soundMap and print keys")

    p_eval = sub.add_parser("eval", help="Evaluate JS expression")
    p_eval.add_argument("expression", help="JavaScript expression to evaluate")

    return p.parse_args()


def require_pychrome() -> Any:
    try:
        import pychrome  # type: ignore

        return pychrome
    except Exception as exc:  # noqa: BLE001
        eprint(
            "Missing dependency: pychrome. Install with:\n"
            "  pip install pychrome\n"
            "(It talks to Chrome DevTools Protocol.)"
        )
        raise SystemExit(2) from exc


def pick_tab(browser: Any, selector: Optional[str]) -> Any:
    tabs = browser.list_tab()
    if not tabs:
        raise SystemExit("No tabs found on the DevTools endpoint")
    if not selector:
        return tabs[0]

    selector_l = selector.lower()
    for t in tabs:
        url = (t.url or "").lower()
        title = (t.title or "").lower()
        if selector_l in url or selector_l in title:
            return t

    raise SystemExit(f"No tab matched --tab {selector!r}")


def eval_js(tab: Any, expression: str) -> Any:
    res = tab.Runtime.evaluate(
        expression=f"({expression})",
        returnByValue=True,
        awaitPromise=True,
    )
    if "exceptionDetails" in res:
        details = res["exceptionDetails"]
        text = details.get("text") or "JavaScript exception"
        eprint(text)
        if "exception" in details:
            eprint(json.dumps(details["exception"], indent=2)[:4000])
        raise SystemExit(1)

    result = res.get("result", {})
    if "value" in result:
        return result["value"]
    # fall back for unserializable results
    return result


def main() -> None:
    ns = parse_args()
    pychrome = require_pychrome()

    browser = pychrome.Browser(url=f"http://{ns.host}:{ns.port}")
    tab = pick_tab(browser, ns.tab)

    tab.start()
    tab.Runtime.enable()

    try:
        if ns.cmd == "list":
            for t in browser.list_tab():
                print(f"- {t.id}  {t.title}  {t.url}")
            return

        if ns.cmd == "globals":
            val = eval_js(
                tab,
                "Object.keys(window).filter(k => /sound|sample/i.test(k)).slice(0,200)",
            )
            print(json.dumps(val, indent=2))
            return

        if ns.cmd == "soundmap":
            val: Dict[str, Any] = {}
            val["soundMapType"] = eval_js(
                tab, "Object.prototype.toString.call(window.soundMap)"
            )
            val["soundMapHasGet"] = eval_js(tab, "typeof window.soundMap?.get")
            val["soundMapHasEntries"] = eval_js(
                tab, "typeof window.soundMap?.entries"
            )
            val["soundMapKeySample"] = eval_js(
                tab,
                "(() => {\n"
                "  const sm = window.soundMap;\n"
                "  const obj = sm?.get ? sm.get() : sm;\n"
                "  if (!obj || typeof obj !== 'object') return null;\n"
                "  return Object.keys(obj).slice(0, 50);\n"
                "})()",
            )
            print(json.dumps(val, indent=2))
            return

        if ns.cmd == "eval":
            val = eval_js(tab, ns.expression)
            print(json.dumps(val, indent=2) if not isinstance(val, str) else val)
            return

        raise SystemExit(f"Unknown cmd: {ns.cmd}")

    finally:
        tab.stop()


if __name__ == "__main__":
    main()
