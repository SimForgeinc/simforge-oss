# OpenSCENARIO runtime conformance corpus

These deterministic OpenSCENARIO 1.4 files are shared contract fixtures for
the public writer and every execution adapter, including the optional CARLA
adapter (`adapters/carla-exec`) and the hosted render workers.

They cover all supported signal indications, appearance state changes, and
actor despawn semantics. Consumers must compile these exact bytes and produce
deterministic plans. Do not maintain a private copy in a product repository;
consume these files from this repository at a pinned revision.
