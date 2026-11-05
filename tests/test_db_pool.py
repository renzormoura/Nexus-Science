"""Reaproveitamento de conexoes PostgreSQL (com um `psycopg` falso: nao precisa de servidor)."""

from __future__ import annotations

import sys
import types

import pytest

import db


class FakeConnection:
    def __init__(self, broken_when_idle: bool = False) -> None:
        self.closed = False
        self.info = types.SimpleNamespace(transaction_status=0)
        self.broken_when_idle = broken_when_idle
        self.commits = 0
        self.rollbacks = 0

    def cursor(self):
        return types.SimpleNamespace(execute=lambda *a: None, close=lambda: None, rowcount=1, fetchall=list)

    def execute(self, sql):
        if self.broken_when_idle:
            raise OSError("conexao encerrada pelo servidor")

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closed = True


@pytest.fixture
def pg(monkeypatch):
    created: list[FakeConnection] = []
    fake = types.ModuleType("psycopg")

    def connect(url, **kwargs):
        created.append(FakeConnection())
        return created[-1]

    fake.connect = connect  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "psycopg", fake)
    return db.Database(database_url="postgresql://x/y"), created


def test_connection_is_reused_between_operations(pg):
    database, created = pg
    database.execute("SELECT 1")
    database.query("SELECT 2")
    assert len(created) == 1 and created[0].commits == 2 and not created[0].closed


def test_failed_transaction_rolls_back_and_connection_still_returns(pg):
    database, created = pg
    with pytest.raises(ValueError), database.transaction():
        raise ValueError("falhou")
    assert created[0].rollbacks == 1
    database.execute("SELECT 1")
    assert len(created) == 1


def test_connection_in_the_middle_of_a_transaction_is_discarded(pg):
    database, created = pg
    with pytest.raises(ValueError), database.transaction():
        created[0].info.transaction_status = 3  # erro na transacao: nao volta ao conjunto
        raise ValueError("falhou")
    assert created[0].closed
    database.execute("SELECT 1")
    assert len(created) == 2


def test_stale_dead_connection_is_replaced(pg, monkeypatch):
    database, created = pg
    database.execute("SELECT 1")
    created[0].broken_when_idle = True  # o servidor derrubou a conexao enquanto ela estava parada
    later = db.time.monotonic() + 10_000.0  # relogio real + muito tempo: independe de quanto o computador esta ligado
    monkeypatch.setattr(db.time, "monotonic", lambda: later)
    database.execute("SELECT 1")
    assert len(created) == 2 and created[0].closed and created[1].commits == 1


def test_idle_pool_is_capped(pg):
    database, created = pg
    contexts = [database.transaction() for _ in range(db._IDLE_MAX + 3)]
    for context in contexts:
        context.__enter__()
    for context in contexts:
        context.__exit__(None, None, None)
    assert len(created) == db._IDLE_MAX + 3
    assert sum(not conn.closed for conn in created) == db._IDLE_MAX
