"""The teacher must not recover privileged truth through the native state slots."""
import numpy as np
import pytest

torch = pytest.importorskip('torch')

from simforge_oss_gym.train.model import Teacher
from simforge_oss_gym.train.serve import native_observation


def test_actions_ignore_hidden_actors_absolute_position_and_object_order() -> None:
    torch.manual_seed(14)
    model = Teacher(hidden=32).eval()
    state = torch.zeros(1, 10)
    state[:, 4] = 6.0
    objects = torch.zeros(1, 64, 5)
    objects[0, 0] = torch.tensor([12.0, 0.2, -4.0, 1.0, 1.0])
    objects[0, 1] = torch.tensor([2.0, -0.3, -8.0, 0.0, 1.0])
    with torch.no_grad():
        reference = model.deterministic(state, objects)
        altered = state.clone()
        altered[:, [0, 1, 2, 3, 8, 9]] = 10000
        hidden_changed = objects.clone()
        hidden_changed[0, 1, :3] = torch.tensor([0.01, 2.0, -100.0])
        # Permuting the set and changing hidden truth cannot alter the decision.
        actual = model.deterministic(altered, hidden_changed.flip(1))
    torch.testing.assert_close(actual, reference, rtol=1e-6, atol=1e-6)


def test_empty_native_object_list_has_identical_semantics_to_padded_batch() -> None:
    state, objects = native_observation({'state_vector': [0.0] * 10, 'objects': []})
    torch.manual_seed(4)
    model = Teacher(hidden=32).eval()
    with torch.no_grad():
        a = model.deterministic(torch.from_numpy(state), torch.from_numpy(objects))
        b = model.deterministic(torch.zeros(1, 10), torch.zeros(1, 64, 5))
    torch.testing.assert_close(a, b, rtol=0, atol=0)
    assert np.isfinite(a.numpy()).all()


def test_server_refuses_missing_native_state_instead_of_fabricating_it() -> None:
    with pytest.raises(ValueError, match='real native state_vector'):
        native_observation({'pose': {'speedMps': 3.0}, 'actors': []})
