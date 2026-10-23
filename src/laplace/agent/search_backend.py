"""Select the native ruleset before searching, including all descendant nodes."""

import importlib.util
import sys
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=1)
def no_tera_engine():
    path = Path(sys.prefix) / "laplace-no-tera" / "poke_engine" / "__init__.py"
    if not path.exists():
        raise RuntimeError(
            "AAA requires the Gen 9 engine built without Terastallization. "
            "Run: python -m laplace.cli.build_no_tera_engine"
        )
    name = "_laplace_no_tera_engine"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    return module


def search(state, duration_ms, *, threads=1, allow_tera=True):
    if allow_tera:
        from poke_engine import monte_carlo_tree_search
        return monte_carlo_tree_search(state, duration_ms, threads=threads)
    engine = no_tera_engine()
    return engine.monte_carlo_tree_search(
        engine.State.from_string(state.to_string()), duration_ms, threads=threads
    )
