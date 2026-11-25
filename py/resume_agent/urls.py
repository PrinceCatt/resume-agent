"""Job links reduced to what identifies the posting (shared by jobs.py and discover.py)."""

from __future__ import annotations

import re
from urllib.parse import parse_qsl, urlencode, urlsplit

_TRACKING = re.compile(
    r"^(utm_|ref$|refid$|trk|trackingid$|src$|source$|gh_src$|lever-(source|origin)|fbclid$|gclid$|mc_|_hs|origin$)", re.I
)


def normalize_url(raw: str) -> str:
    """A link reduced to what identifies the posting: no tracking parameters, fragment, www or trailing slash."""
    s = raw.strip()
    try:
        u = urlsplit(s if re.match(r"^https?://", s, re.I) else f"https://{s}")
        host = u.hostname
        if not host or re.search(r"\s", u.netloc):
            raise ValueError("bad host")
        params = [(k, v) for k, v in parse_qsl(u.query, keep_blank_values=True) if not _TRACKING.match(k)]
        params.sort(key=lambda kv: kv[0])
        q = urlencode(params)
        path = re.sub(r"/+$", "", u.path)
        return f"{re.sub(r'^www\.', '', host)}{path}{'?' + q if q else ''}"
    except ValueError:
        return s.lower()
