"""Build a separate Gen 9 native engine without Tera; requires Rust and a C linker."""

import subprocess
import sys
from pathlib import Path


def main():
    # A separate target preserves the ordinary Gen 9 + Tera engine used by OU/randbats.
    target = Path(sys.prefix) / "laplace-no-tera"
    subprocess.run([
        sys.executable, "-m", "pip", "install", "--upgrade", "--no-deps",
        "--no-binary=poke-engine", "--no-cache-dir", "--target", str(target),
        "--config-settings", "build-args=--no-default-features --features poke-engine/gen9",
        "poke-engine==0.0.47",
    ], check=True)
    from laplace.agent.search_backend import no_tera_engine
    engine = no_tera_engine()
    mon = engine.Pokemon(id="pikachu", moves=[engine.Move(id="tackle")], tera_type="electric")
    state = engine.State(side_one=engine.Side(pokemon=[mon]), side_two=engine.Side(pokemon=[mon]))
    result = engine.monte_carlo_tree_search(state, 10)
    for side in (result.side_one, result.side_two):
        if not side or any(option.move_choice.endswith("-tera") for option in side):
            raise RuntimeError("The built engine did not pass the no-Tera check")
    print(f"AAA engine ready: {target}")


if __name__ == "__main__":
    main()
