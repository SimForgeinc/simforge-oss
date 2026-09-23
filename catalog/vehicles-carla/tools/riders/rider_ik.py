"""Offline re-evaluation of CARLA's AB_Biker rider graph on a glTF skeleton.

CARLA 0.10 attaches an ordinary G2 pedestrian skeletal mesh to every
two-wheeler blueprint and drives it with the anim blueprint
`Animations/Base/AB_Biker`: a static grip pose (`AS_Pedestrian_BikeHands`),
ModifyBone on `crl_hips__C` (seat location + torso rotation), LookAt on
`crl_Head__C`, and two-bone IK of hands to the handlebar sockets and feet to
the pedal bones. The pedal bones orbit the crank, so pedalling is purely
IK-driven. This module evaluates the same graph in numpy so the result can be
baked into glTF joint channels.
"""
import math

import numpy as np

X = np.array([1.0, 0.0, 0.0])
Y = np.array([0.0, 1.0, 0.0])
Z = np.array([0.0, 0.0, 1.0])


def norm(v):
    n = np.linalg.norm(v)
    assert n > 1e-9, v
    return v / n


def quat_to_mat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def mat_to_quat(m):
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        q = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, 0.25 * s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s, (m[1, 0] - m[0, 1]) / s]
    q = np.array(q)
    q /= np.linalg.norm(q)
    return q if q[3] >= 0 else -q


def axis_angle(axis, angle):
    axis = norm(np.asarray(axis, dtype=float))
    x, y, z = axis
    c, s, t = math.cos(angle), math.sin(angle), 1 - math.cos(angle)
    return np.array([[t * x * x + c, t * x * y - s * z, t * x * z + s * y],
                     [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
                     [t * x * z - s * y, t * y * z + s * x, t * z * z + c]])


def rotation_between(a, b):
    a, b = norm(a), norm(b)
    axis = np.cross(a, b)
    s = np.linalg.norm(axis)
    c = float(np.dot(a, b))
    if s < 1e-12:
        assert c > 0, 'antiparallel rotation is ambiguous'
        return np.eye(3)
    return axis_angle(axis, math.atan2(s, c))


def frame(direction, hinge):
    d = norm(direction)
    h = norm(hinge - np.dot(hinge, d) * d)
    return np.column_stack([d, h, np.cross(d, h)])


class Pose:
    """Local TRS of a node subtree with world evaluation (uniform scale 1)."""

    def __init__(self, nodes, root, root_world):
        self.nodes = nodes
        self.parent = {c: i for i, n in enumerate(nodes) for c in n.get('children', [])}
        self.order = []
        stack = [root]
        while stack:
            i = stack.pop()
            self.order.append(i)
            stack.extend(reversed(nodes[i].get('children', [])))
        self.root = root
        self.root_world = root_world
        self.t = {}
        self.r = {}
        for i in self.order:
            n = nodes[i]
            assert 'matrix' not in n, 'matrix nodes are not supported'
            s = n.get('scale', [1, 1, 1])
            assert max(abs(v - 1) for v in s) < 1e-4, (n.get('name'), s)
            self.t[i] = np.array(n.get('translation', [0.0, 0.0, 0.0]), dtype=float)
            self.r[i] = quat_to_mat(n.get('rotation', [0.0, 0.0, 0.0, 1.0]))
        self.by_name = {nodes[i].get('name'): i for i in self.order}
        self.evaluate()

    def copy(self):
        other = object.__new__(Pose)
        other.__dict__.update(self.__dict__)
        other.t = {k: v.copy() for k, v in self.t.items()}
        other.r = {k: v.copy() for k, v in self.r.items()}
        other.evaluate()
        return other

    def evaluate(self):
        self.wr = {}
        self.wt = {}
        for i in self.order:
            if i == self.root:
                pr, pt = self.root_world
            else:
                pr, pt = self.wr[self.parent[i]], self.wt[self.parent[i]]
            self.wr[i] = pr @ self.r[i]
            self.wt[i] = pr @ self.t[i] + pt

    def id(self, name):
        return self.by_name[name]

    def pos(self, name):
        return self.wt[self.id(name)]

    def rot(self, name):
        return self.wr[self.id(name)]

    def set_world_rot(self, name, world):
        i = self.id(name)
        parent = self.wr[self.parent[i]] if i != self.root else self.root_world[0]
        self.r[i] = parent.T @ world
        self.evaluate()

    def rotate_world(self, name, delta):
        self.set_world_rot(name, delta @ self.rot(name))


def two_bone(pose, rest, a, b, c, target, pole, motion):
    """Place the chain a-b-c so that c reaches `target`.

    `motion` is the direction the distal bone moves when the joint `b`
    flexes from the rest pose; the rest hinge is derived from it, so the joint
    only ever bends about its anatomical hinge (no sideways knees/elbows).
    Returns the reach ratio |target-a| / (l1+l2) before clamping.
    """
    pa, pb, pc = pose.pos(a), pose.pos(b), pose.pos(c)
    l1, l2 = np.linalg.norm(pb - pa), np.linalg.norm(pc - pb)
    ra, rb, rc = rest.pos(a), rest.pos(b), rest.pos(c)
    u0, w0 = norm(rb - ra), norm(rc - rb)
    h0 = norm(np.cross(u0, motion))
    to_target = target - pa
    reach = np.linalg.norm(to_target) / (l1 + l2)
    d = min(max(np.linalg.norm(to_target), abs(l1 - l2) + 1e-4), (l1 + l2) * (1 - 1e-4))
    t_hat = norm(to_target)
    p_perp = norm(pole - np.dot(pole, t_hat) * t_hat)
    cos_a = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)
    knee = pa + l1 * (cos_a * t_hat + math.sqrt(max(0.0, 1 - cos_a * cos_a)) * p_perp)
    end = pa + d * t_hat
    u, w = norm(knee - pa), norm(end - knee)
    h = np.cross(u, w)
    h = norm(h) if np.linalg.norm(h) > 1e-6 else norm(np.cross(u, p_perp))
    pose.set_world_rot(a, frame(u, h) @ frame(u0, h0).T @ rest.rot(a))
    pose.set_world_rot(b, frame(w, h) @ frame(w0, h0).T @ rest.rot(b))
    return reach
