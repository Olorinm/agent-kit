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
    ("larksuite/cli", "v1.0.100", "ac22a60a23d66c37d43a7ec6d9e99b99a4320356", "cf578bb878407673b441cebb0bcb9b2d8f2204c19c65f50df1f6cce7694e7cfb"),
    ("googleworkspace/cli", "v0.22.5", "705fb0ecac6f4249679958f6325b809b63fdde17", "1e55ec8c6ee87fac7d422975604a2d546c35f6d687a1cfaba7c7cc0d3c05663f"),
    ("vercel-labs/agent-browser", "v0.43.0", "1cc19526f3641c8543d55aa6700e7c55b37ac356", "ed52840279526f057977a98e99d60fe0ab760122ee73ce11f4cf050e47938913"),
)


def selected(agency, name):
    if agency == "larksuite":
        return name.startswith("lark-")
    if agency == "googleworkspace":
        return name == "gws-shared" or name == "gws-gmail" or name.startswith("gws-gmail-")
    return name == "agent-browser"


def build(directory, output):
    files = {name: ((ROOT / source).read_bytes(), 0o644) for name, source in (
        ("install.sh", "install-skills.sh"), ("install.mjs", "install-skills.mjs"), ("previous-trees.json", "previous-trees.json"))}
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
