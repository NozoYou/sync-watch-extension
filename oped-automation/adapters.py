"""Resolve public media sources through replaceable website adapters."""

from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen


def public_url(value):
    parsed = urlparse(value)
    if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("A valid HTTP(S) URL without embedded credentials is required.")
    return value


def request(url):
    return Request(public_url(url), headers={"User-Agent": "SyncWatch-OPED/0.1"})


class MediaParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.media_depth = 0
        self.sources = []

    def handle_starttag(self, tag, attributes):
        attributes = dict(attributes)
        if tag in ("audio", "video"):
            self.media_depth += 1
            if attributes.get("src"):
                self.sources.append(attributes["src"])
        elif tag == "source" and self.media_depth and attributes.get("src"):
            self.sources.append(attributes["src"])

    def handle_endtag(self, tag):
        if tag in ("audio", "video"):
            self.media_depth = max(0, self.media_depth - 1)


def resolve_media(episode):
    # Browser-specific adapters can supply an authorized, direct audio URL.
    if episode.get("audioUrl"):
        return public_url(episode["audioUrl"])
    with urlopen(request(episode["url"]), timeout=30) as response:
        content = response.read(2_000_001)
        if len(content) > 2_000_000:
            raise ValueError("Page exceeds the HTML size limit.")
        parser = MediaParser()
        parser.feed(content.decode(response.headers.get_content_charset() or "utf-8", errors="replace"))
        page_url = response.geturl()
    if not parser.sources:
        raise ValueError(
            "No static media source found. This website requires a browser/player adapter."
        )
    source = public_url(urljoin(page_url, parser.sources[0]))
    if urlparse(source).path.lower().endswith((".m3u8", ".mpd")):
        raise ValueError("Segmented streams require a dedicated download adapter.")
    return source


def download_media(url, destination, maximum_bytes=256 * 1024 * 1024):
    temporary = destination.with_suffix(".part")
    try:
        with urlopen(request(url), timeout=30) as response, temporary.open("wb") as output:
            size = 0
            while chunk := response.read(256 * 1024):
                size += len(chunk)
                if size > maximum_bytes:
                    raise ValueError("Media exceeds the download size limit.")
                output.write(chunk)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
