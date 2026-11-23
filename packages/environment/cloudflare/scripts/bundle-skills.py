"""Build the offline bundle from three verified, locally supplied official release tarballs.

Usage: python3 scripts/bundle-skills.py DIRECTORY [OUTPUT]
Download each release archive from https://codeload.github.com/<repo>/tar.gz/refs/tags/<tag>
and save it as <organization>.tgz in DIRECTORY. See SOURCES below.
"""

import gzip
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile

ROOT = Path(__file__).resolve().parent
SOURCES = (
    ("larksuite/cli", "v1.0.97", "72579c80027c863ca51d5f9affda72a70ab0d8a6", "58e9a73c321d404098c06ab8646d65f8b00c7d970963193bba58a504145c9388"),
    ("googleworkspace/cli", "v0.22.5", "705fb0ecac6f4249679958f6325b809b63fdde17", "1e55ec8c6ee87fac7d422975604a2d546c35f6d687a1cfaba7c7cc0d3c05663f"),
    ("vercel-labs/agent-browser", "v0.41.2", "d52a5e90c372ec4710c69adc3837ac14bbd852aa", "5deccde57db7ed416d46a57e3c2767fba74f96e750d1d8fabe79bfa1f4bd228b"),
)


def selected(agency, name):
    if agency == "larksuite":
        return name.startswith("lark-")
    if agency == "googleworkspace":
        return name == "gws-shared" or name == "gws-gmail" or name.startswith("gws-gmail-")
    return name == "agent-browser"


def build(directory, output):
    files = {"install.sh": ((ROOT / "install-skills.sh").read_bytes(), 0o644)}
    provenance = []
    for repo, tag, commit, digest in SOURCES:
        org = repo.split("/")[0]
        archive = (directory / (org + ".tgz")).read_bytes()
        if hashlib.sha256(archive).hexdigest() != digest:
            raise ValueError(f"unexpected archive digest for {repo} {tag}")
        names = set()
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as upstream:
            for member in upstream:
                if not member.isfile():
                    continue
                parts = member.name.split("/")[1:]
                if parts == ["LICENSE"]:
                    path = "licenses/" + org + ".txt"
                elif len(parts) >= 3 and parts[0] == "skills" and selected(org, parts[1]):
                    path = "/".join(parts)
                    names.add(parts[1])
                else:
                    continue
                files[path] = (upstream.extractfile(member).read(), member.mode & 0o777)
        provenance.append({"repository": "https://github.com/" + repo, "tag": tag, "commit": commit,
                           "archiveSha256": digest, "skills": sorted(names)})
    files["sources.json"] = ((json.dumps(provenance, indent=2) + "\n").encode(), 0o644)
    with output.open("wb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as zipped:
        with tarfile.open(fileobj=zipped, mode="w|", format=tarfile.GNU_FORMAT) as out:
            for name, (data, mode) in sorted(files.items()):
                info = tarfile.TarInfo(name)
                info.mode = mode
                info.size = len(data)
                out.addfile(info, io.BytesIO(data))


if __name__ == "__main__":
    build(Path(sys.argv[1]), Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT.parent / "examples" / "official-skills.tgz")
