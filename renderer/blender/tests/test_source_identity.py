"""Equal mesh bytes at different locations must not collapse provenance."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from geometry_jobs import sha, source_identity  # noqa: E402


def test_identical_bytes_preserve_independent_source_locations(tmp_path):
    first, second = tmp_path / 'first.glb', tmp_path / 'second.glb'
    first.write_bytes(b'identical source bytes')
    second.write_bytes(first.read_bytes())
    digest = sha(first)
    assert sha(second) == digest
    assert source_identity(first, digest) != source_identity(second, digest)
    prior = source_identity(second, digest)
    second.write_bytes(b'changed source bytes')
    assert source_identity(second, sha(second)) != prior
    assert sha(first) == digest


def test_aliases_of_one_source_have_one_identity(tmp_path):
    source, alias = tmp_path / 'source.glb', tmp_path / 'alias.glb'
    source.write_bytes(b'immutable source')
    alias.symlink_to(source)
    assert source_identity(alias, sha(alias)) == source_identity(source, sha(source))
