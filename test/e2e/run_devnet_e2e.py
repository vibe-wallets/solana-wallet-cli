"""Run real-chain smoke coverage against an explicitly verified Solana Devnet.

This runner is intentionally separate from run_tests.py: ordinary CI and
pull-request Docker tests remain deterministic and never contact a faucet.
"""

import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import time

from devnet_rpc_proxy import DevnetRpcProxy
from keypair import write_keypair


DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
DEFAULT_RPC_URL = "https://api.devnet.solana.com"
IMAGE = os.environ.get("SOL_WALLET_E2E_IMAGE")
RPC_URL = os.environ.get("SOL_WALLET_DEVNET_RPC_URL") or DEFAULT_RPC_URL


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def direct_rpc(method, params=None):
    import urllib.error
    import urllib.request

    body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}
    ).encode()
    request = urllib.request.Request(
        RPC_URL, data=body, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            payload = json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Devnet RPC {method} returned HTTP {error.code}.") from None
    except (TimeoutError, urllib.error.URLError, OSError, json.JSONDecodeError):
        raise RuntimeError(f"Devnet RPC {method} could not be completed.") from None
    if "error" in payload:
        error = payload["error"]
        code = error.get("code", "unknown") if isinstance(error, dict) else "unknown"
        raise RuntimeError(f"Devnet RPC {method} returned error {code}.")
    return payload["result"]


def helper(action, *args):
    environment = os.environ.copy()
    environment["SOL_WALLET_DEVNET_RPC_URL"] = RPC_URL
    result = subprocess.run(
        ["node", "test/e2e/devnet_fixtures.mjs", action, *map(str, args)],
        capture_output=True,
        text=True,
        timeout=240,
        env=environment,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "Devnet fixture setup failed.")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        raise RuntimeError("Devnet fixture helper returned malformed output.") from None


def docker_base(directory, image, interactive=False):
    flags = ["run", "--rm", "-it" if interactive else "-i", "--network", "host"]
    if os.name == "posix" and hasattr(os, "getuid"):
        flags.extend(["--user", f"{os.getuid()}:{os.getgid()}"])
    flags.extend(
        [
            "-e",
            "SOL_WALLET_CONFIG_DIR=/home/solwallet/.config/sol-wallet",
            "-e",
            "SOL_WALLET_CLUSTER=devnet",
            "-e",
            f"SOL_WALLET_RPC_URL=http://127.0.0.1:{PROXY_PORT}",
            "-v",
            f"{directory}:/home/solwallet/.config/sol-wallet",
            image,
        ]
    )
    return ["docker", *flags]


def json_payload(output):
    payloads = []
    for line in output.splitlines():
        try:
            value = json.loads(line.strip())
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(value, dict):
            payloads.append(value)
    return payloads[-1] if payloads else None


def run_cli(directory, image, command, passphrase=None, yes=False, answer=None):
    import pexpect

    args = [
        *docker_base(
            directory, image, interactive=passphrase is not None or answer is not None
        )
    ]
    args.extend(["-c", command, "--json"])
    if yes:
        args.append("--yes")

    if passphrase is None and answer is None:
        result = subprocess.run(args, capture_output=True, text=True, timeout=120)
        return result.returncode, result.stdout, result.stderr

    child = pexpect.spawn(args[0], args[1:], encoding="utf-8", timeout=180, echo=False)
    pieces = []
    answered = False
    unlocked = False
    while True:
        expected = []
        if answer is not None and not answered:
            expected.append(r"\[y/N\]")
        if passphrase is not None and not unlocked:
            expected.append(r"Passphrase for [^\r\n]+: ")
        expected.append(pexpect.EOF)
        matched = child.expect(expected)
        pieces.append(child.before)
        if expected[matched] == pexpect.EOF:
            break
        pieces.append(child.after)
        if answer is not None and not answered and expected[matched] == r"\[y/N\]":
            child.sendline(answer)
            answered = True
        elif passphrase is not None and not unlocked:
            child.sendline(passphrase)
            unlocked = True
    child.close()
    output = "".join(pieces)
    return child.exitstatus if child.exitstatus is not None else 1, output, ""


def run_import(directory, image, keypair_path, passphrase):
    import pexpect

    mounted_keypair_path = (
        "/home/solwallet/.config/sol-wallet/" + Path(keypair_path).name
    )
    command = "wallet import devnet-e2e --keypair-file " + mounted_keypair_path
    args = [*docker_base(directory, image, interactive=True), "-c", command, "--json"]
    child = pexpect.spawn(args[0], args[1:], encoding="utf-8", timeout=180, echo=False)
    pieces = []
    for pattern, answer in [
        ("Is this the expected wallet address?", "y"),
        ("New keystore passphrase:", passphrase),
        ("Confirm passphrase:", passphrase),
    ]:
        child.expect(pattern)
        pieces.extend([child.before, child.after])
        child.sendline(answer)
    child.expect(pexpect.EOF)
    pieces.append(child.before)
    child.close()
    output = "".join(pieces)
    require(child.exitstatus == 0, "throwaway wallet import failed: " + output)
    require(passphrase not in output, "wallet passphrase appeared in terminal output")
    return output


def call_cli(directory, image, command, passphrase=None, yes=False, answer=None):
    code, stdout, stderr = run_cli(
        directory, image, command, passphrase=passphrase, yes=yes, answer=answer
    )
    combined = stdout + "\n" + stderr
    payload = json_payload(combined)
    return code, payload, combined


def success(directory, image, command, passphrase=None, yes=False):
    code, payload, output = call_cli(
        directory, image, command, passphrase=passphrase, yes=yes
    )
    require(code == 0, f"`{command}` failed (exit {code}): {output}")
    require(
        payload is not None and payload.get("ok") is True,
        f"`{command}` did not return successful JSON: {output}",
    )
    return payload


def failure(directory, image, command):
    code, payload, output = call_cli(directory, image, command)
    require(code != 0, f"`{command}` unexpectedly succeeded")
    require(
        payload is not None and payload.get("ok") is False,
        f"`{command}` did not return a JSON error: {output}",
    )
    return payload


def amount_from_lamports(value):
    whole, fractional = divmod(int(value), 1_000_000_000)
    decimal = f"{fractional:09d}".rstrip("0")
    return str(whole) if not decimal else f"{whole}.{decimal}"


def method_count(proxy, method):
    return sum(record["method"] == method for record in proxy.snapshot())


def run(image):
    global PROXY_PORT

    genesis = direct_rpc("getGenesisHash")
    require(
        genesis == DEVNET_GENESIS, "configured RPC did not identify as Solana Devnet"
    )
    print("PASS: direct RPC genesis check identifies Devnet before any faucet/write")

    with tempfile.TemporaryDirectory(prefix="sol-wallet-devnet-e2e-") as temporary:
        directory = Path(temporary)
        directory.chmod(0o700)
        wallet_key = directory / "throwaway-keypair.json"
        recipient_key = directory / "recipient-keypair.json"
        wallet_address = write_keypair(wallet_key)
        recipient_address = write_keypair(recipient_key)

        fixtures = helper("prepare", wallet_key, recipient_key)
        require(
            fixtures["wallet"] == wallet_address,
            "prepared payer does not match the generated wallet",
        )
        require(
            fixtures["recipient"] == recipient_address,
            "prepared recipient does not match generated recipient",
        )
        print(
            "PASS: bounded Devnet faucet funding and disposable legacy/Token-2022 fixtures"
        )

        passphrase = secrets.token_urlsafe(24)
        with DevnetRpcProxy(RPC_URL) as proxy:
            PROXY_PORT = proxy.server_address[1]
            run_import(directory, image, wallet_key, passphrase)

            address_result = success(directory, image, "address")
            require(
                address_result.get("address") == wallet_address,
                "address command returned the wrong wallet",
            )
            wallet_list = success(directory, image, "wallet list")
            require(
                any(
                    item.get("alias") == "devnet-e2e"
                    for item in wallet_list.get("wallets", [])
                ),
                "wallet list omitted the imported alias",
            )
            wallet_info = success(directory, image, "wallet info devnet-e2e")
            require(
                wallet_info.get("wallet", {}).get("address") == wallet_address,
                "wallet info did not match the imported key",
            )
            config = success(directory, image, "show config")
            require(
                config.get("cluster") == "devnet",
                "CLI did not retain Devnet configuration",
            )
            require(
                "[REDACTED]" not in config.get("rpcUrl", ""),
                "local proxy URL was unexpectedly redacted",
            )
            print(
                "PASS: CLI wallet identity, local wallet metadata, and Devnet configuration"
            )

            initial = helper(
                "balances", wallet_key, recipient_key, json.dumps(fixtures)
            )
            require(
                int(initial["legacy"]["source"]) == 2_500_000,
                "legacy mint fixture was not funded as expected",
            )
            require(
                int(initial["token2022"]["source"]) == 2_500_000,
                "Token-2022 fixture was not funded as expected",
            )
            require(
                int(initial["legacy"]["destination"]) == 0,
                "legacy recipient ATA existed before its first CLI transfer",
            )
            require(
                int(initial["token2022"]["destination"]) == 0,
                "Token-2022 recipient ATA existed before its first CLI transfer",
            )
            before_balance = int(
                direct_rpc("getBalance", [wallet_address, {"commitment": "confirmed"}])[
                    "value"
                ]
            )
            balance = success(directory, image, "balance")
            require(
                int(balance.get("lamports", -1)) == before_balance,
                "CLI SOL balance differs from direct Devnet RPC",
            )

            validators = success(
                directory, image, "validators --limit 8 --max-commission 10"
            )
            vote_data = direct_rpc("getVoteAccounts", [{"commitment": "confirmed"}])
            current_votes = {
                item["votePubkey"]: item for item in vote_data.get("current", [])
            }
            selected_validators = validators.get("validators", [])
            require(
                bool(selected_validators),
                "Devnet returned no current validators within the commission ceiling",
            )
            require(
                all(
                    row["voteAccount"] in current_votes
                    and current_votes[row["voteAccount"]]["commission"] <= 10
                    for row in selected_validators
                ),
                "validators output disagreed with direct getVoteAccounts data",
            )
            require(
                [int(row["activatedStake"]) for row in selected_validators]
                == sorted(
                    (int(row["activatedStake"]) for row in selected_validators),
                    reverse=True,
                ),
                "validators were not sorted by activated stake",
            )

            status = success(directory, image, "status")
            require(status.get("health") == "healthy", "Devnet status was not healthy")
            require(
                status.get("positions", {}).get("jupiterLend", {}).get("status")
                == "not_supported",
                "status did not mark Jupiter Lend as unsupported on Devnet",
            )
            stake_list = success(directory, image, "stake list")
            require(
                isinstance(stake_list.get("accounts"), list),
                "stake list returned no account list",
            )
            print(
                "PASS: balance, status, validator filters/order, and stake discovery use live Devnet RPC"
            )

            token_list = success(directory, image, "token list")
            listed_mints = {entry["mint"] for entry in token_list.get("accounts", [])}
            require(
                {fixtures["legacyMint"], fixtures["token2022Mint"]} <= listed_mints,
                "token list omitted one or both supported token programs",
            )
            account_list = success(directory, image, "token list --accounts")
            require(
                len(
                    [
                        entry
                        for entry in account_list.get("accounts", [])
                        if entry["mint"] in listed_mints
                    ]
                )
                >= 2,
                "token list --accounts omitted fixture accounts",
            )
            for mint in [fixtures["legacyMint"], fixtures["token2022Mint"]]:
                token_balance = success(directory, image, f"token balance {mint}")
                require(
                    token_balance.get("amount") == "2.5",
                    f"token balance for {mint} was not the minted amount",
                )

            symbols = success(directory, image, "token symbols")
            devnet_usdc = next(
                (
                    entry
                    for entry in symbols.get("symbols", [])
                    if entry.get("symbol") == "usdc"
                ),
                None,
            )
            require(
                devnet_usdc is not None
                and devnet_usdc.get("mint")
                == "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
                and devnet_usdc.get("testOnly") is True,
                "token symbols did not expose the Devnet USDC test mapping",
            )
            symbol_balance = success(directory, image, "token balance usdc")
            require(
                symbol_balance.get("mint") == devnet_usdc["mint"],
                "token balance usdc did not resolve to the Devnet USDC mint",
            )
            print(
                "PASS: token symbols and symbol-based balance resolution use the Devnet mapping"
            )

            validator = selected_validators[0]["voteAccount"]
            stake_amount = amount_from_lamports(fixtures["minimumDelegationLamports"])
            send_before = method_count(proxy, "sendTransaction")
            dry = success(
                directory,
                image,
                f"stake create {stake_amount} --validator {validator} --dry-run",
            )
            require(
                dry.get("status") == "simulated",
                "stake create dry-run was not simulated",
            )
            require(
                method_count(proxy, "simulateTransaction") > 0,
                "stake dry-run did not reach transaction simulation",
            )
            require(
                method_count(proxy, "sendTransaction") == send_before,
                "stake dry-run broadcast a transaction",
            )
            print(
                "PASS: stake create validates live minimum, validator and rent, then simulates without broadcast"
            )

            recipient = fixtures["recipient"]
            send_before = method_count(proxy, "sendTransaction")
            dry = success(directory, image, f"send {recipient} 0.001 --dry-run")
            require(
                dry.get("status") == "simulated",
                "SOL transfer dry-run was not simulated",
            )
            require(
                method_count(proxy, "sendTransaction") == send_before,
                "SOL dry-run broadcast a transaction",
            )

            send_before = method_count(proxy, "sendTransaction")
            cancelled_code, cancelled_payload, cancelled_output = call_cli(
                directory, image, f"send {recipient} 0.001", answer="n"
            )
            require(
                cancelled_code != 0
                and cancelled_payload
                and cancelled_payload.get("ok") is False,
                f"SOL transfer cancellation did not reject: {cancelled_output}",
            )
            require(
                method_count(proxy, "sendTransaction") == send_before,
                "cancelled SOL transfer broadcast a transaction",
            )

            successful_send = success(
                directory, image, f"send {recipient} 0.001", passphrase, yes=True
            )
            signature = successful_send.get("signature")
            require(
                isinstance(signature, str) and len(signature) > 30,
                "SOL send returned no transaction signature",
            )
            after_sol_send = helper(
                "balances", wallet_key, recipient_key, json.dumps(fixtures)
            )
            recipient_balance = int(
                direct_rpc("getBalance", [recipient, {"commitment": "confirmed"}])[
                    "value"
                ]
            )
            require(
                recipient_balance == 1_000_000,
                "Devnet recipient did not receive exactly 0.001 SOL",
            )
            tx = None
            for _ in range(4):
                tx = success(directory, image, f"tx inspect {signature}").get(
                    "transaction"
                )
                if tx is not None:
                    break
                time.sleep(2)
            require(
                tx is not None and tx.get("meta", {}).get("err") is None,
                "tx inspect did not find the confirmed SOL transfer",
            )
            fee_lamports = int(tx["meta"]["fee"])
            require(
                int(after_sol_send["walletLamports"])
                == int(initial["walletLamports"]) - 1_000_000 - fee_lamports,
                "SOL sender balance delta did not equal transfer amount plus confirmed fee",
            )
            print(
                "PASS: SOL dry-run, user cancellation, confirmed transfer, chain balance, and tx inspect"
            )

            for mint_key, mint in [
                ("legacyMint", fixtures["legacyMint"]),
                ("token2022Mint", fixtures["token2022Mint"]),
            ]:
                before_send_count = method_count(proxy, "sendTransaction")
                dry = success(
                    directory, image, f"token send {mint} {recipient} 0.25 --dry-run"
                )
                require(
                    dry.get("status") == "simulated",
                    f"{mint_key} token dry-run was not simulated",
                )
                require(
                    method_count(proxy, "sendTransaction") == before_send_count,
                    f"{mint_key} token dry-run broadcast",
                )

                error = failure(
                    directory, image, f"token send {mint} {recipient} 999999"
                )
                require(
                    error.get("error") == "InsufficientBalance",
                    f"{mint_key} insufficient token path returned an unexpected error",
                )
                require(
                    method_count(proxy, "sendTransaction") == before_send_count,
                    f"{mint_key} insufficient transfer broadcast",
                )

                for amount in ["0.25", "0.1"]:
                    sent = success(
                        directory,
                        image,
                        f"token send {mint} {recipient} {amount}",
                        passphrase,
                        yes=True,
                    )
                    require(
                        isinstance(sent.get("signature"), str),
                        f"{mint_key} token transfer returned no signature",
                    )
                token_balance = success(directory, image, f"token balance {mint}")
                require(
                    token_balance.get("amount") == "2.15",
                    f"{mint_key} wallet token balance after transfers was incorrect",
                )
            token_state = helper(
                "balances", wallet_key, recipient_key, json.dumps(fixtures)
            )
            require(
                int(token_state["legacy"]["destination"]) == 350_000,
                "legacy token recipient balance differed from confirmed transfers",
            )
            require(
                int(token_state["token2022"]["destination"]) == 350_000,
                "Token-2022 recipient balance differed from confirmed transfers",
            )
            print(
                "PASS: legacy SPL and Token-2022 dry-run, insufficient-balance, ATA creation/reuse, and confirmed transfers"
            )

            before = method_count(proxy, "sendTransaction")
            unknown_stake = failure(directory, image, f"stake deactivate {recipient}")
            require(
                unknown_stake.get("error") == "StakeAccountError",
                "invalid stake deactivation returned an unexpected error",
            )
            require(
                method_count(proxy, "sendTransaction") == before,
                "invalid stake deactivation broadcast",
            )
            unknown_withdraw = failure(directory, image, f"stake withdraw {recipient}")
            require(
                unknown_withdraw.get("error") == "StakeAccountError",
                "invalid stake withdrawal returned an unexpected error",
            )
            require(
                method_count(proxy, "sendTransaction") == before,
                "invalid stake withdrawal broadcast",
            )

            before = len(proxy.snapshot())
            for command in [
                "jupiter-lend status",
                "jupiter-lend deposit 1",
                "jupiter-lend withdraw 1",
                "jupiter-lend withdraw --all",
            ]:
                error = failure(directory, image, command)
                require(
                    error.get("error") == "JupiterLendError",
                    f"{command} returned an unexpected Devnet error",
                )
            require(
                len(proxy.snapshot()) == before,
                "Jupiter Lend Devnet guard made an RPC request",
            )
            print(
                "PASS: invalid stake state and all mainnet-only Jupiter Lend paths reject without broadcasting/RPC access"
            )

            direct_after = direct_rpc(
                "getBalance", [wallet_address, {"commitment": "confirmed"}]
            )["value"]
            cli_after = success(directory, image, "balance")
            require(
                int(cli_after["lamports"]) == int(direct_after),
                "post-transfer CLI balance differs from direct chain state",
            )

            cleanup_result = helper(
                "cleanup",
                wallet_key,
                recipient_key,
                json.dumps(fixtures),
            )
            require(
                cleanup_result["tokenAccountsClosed"] == 4,
                "fixture token cleanup did not close all created token accounts",
            )

        print(
            "PASS: Devnet smoke completed; generated encrypted wallet and temporary files are removed by the runner"
        )


def main():
    if not IMAGE:
        raise RuntimeError("SOL_WALLET_E2E_IMAGE must name the built image under test.")
    if shutil.which("docker") is None:
        raise RuntimeError("Docker is required for the Devnet image E2E runner.")
    if shutil.which("node") is None:
        raise RuntimeError("Node.js is required for Devnet fixtures.")
    try:
        import pexpect  # noqa: F401
    except ImportError:
        raise RuntimeError("Install pexpect before running Devnet image E2E.") from None
    run(IMAGE)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Devnet E2E failed: {error}", file=sys.stderr)
        raise SystemExit(1)
