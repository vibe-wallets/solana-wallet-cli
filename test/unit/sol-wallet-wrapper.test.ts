import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("sol-wallet launcher output", () => {
  it.each(["", "ghcr.io/example/sol-wallet:pinned"])(
    "forwards settings and uses the configured image (%s)",
    async (imageOverride) => {
      const { directory, dockerDirectory } = await setupDockerStub();
      const configDirectory = path.join(directory, "custom wallet state");
      const dockerArgsFile = path.join(directory, "docker-args");
      const secretMarker = "wrapper-test-secret-marker";
      const result = spawnSync(
        "bash",
        ["scripts/sol-wallet", "-c", "status --json"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            SOL_WALLET_IMAGE: imageOverride,
            PATH: `${dockerDirectory}:${process.env.PATH ?? ""}`,
            SOL_WALLET_CONFIG_DIR: configDirectory,
            SOL_WALLET_CLUSTER: "devnet",
            SOL_WALLET_RPC_URL: "https://rpc.example.invalid",
            SOL_WALLET_COMMITMENT: "finalized",
            SOL_WALLET_WRAPPER_TEST_SECRET: secretMarker,
            DOCKER_ARGS_FILE: dockerArgsFile,
          },
        },
      );

      const dockerArgs = (await readFile(dockerArgsFile, "utf8"))
        .trim()
        .split("\n");
      const forwardedEnvironment = dockerArgs.flatMap((argument, index) =>
        argument === "--env" ? [dockerArgs[index + 1]] : [],
      );

      expect(result.status).toBe(0);
      const expectedImage =
        imageOverride || "ghcr.io/vibe-wallets/sol-wallet:master";
      expect(result.stderr).toContain(`pull image: ${expectedImage}`);
      expect(dockerArgs).toContain(expectedImage);
      expect(result.stdout).toBe('{"ok":true}\n');
      expect(result.stderr).toContain("master: Pulling latest image");
      expect(forwardedEnvironment).toEqual([
        "SOL_WALLET_CLUSTER",
        "SOL_WALLET_RPC_URL",
        "SOL_WALLET_COMMITMENT",
      ]);
      expect(dockerArgs).toContain(
        `${configDirectory}:/home/solwallet/.config/sol-wallet`,
      );
      expect(dockerArgs).not.toContain("SOL_WALLET_CONFIG_DIR");
      expect(
        `${result.stdout}${result.stderr}${dockerArgs.join("\n")}`,
      ).not.toContain(secretMarker);
    },
  );

  it("does not start the container after a failed pull", async () => {
    const { directory, dockerDirectory } = await setupDockerStub("exit 19");
    const result = spawnSync(
      "bash",
      ["scripts/sol-wallet", "-c", "status --json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dockerDirectory}:${process.env.PATH ?? ""}`,
          SOL_WALLET_CONFIG_DIR: path.join(directory, "config"),
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("master: Pulling latest image");
    expect(result.stderr).not.toContain("container started");
  });
});

async function setupDockerStub(failure = "") {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "sol-wallet-wrapper-"),
  );
  temporaryDirectories.push(directory);
  const dockerDirectory = path.join(directory, "bin");
  await mkdir(dockerDirectory);
  const docker = path.join(dockerDirectory, "docker");
  await writeFile(
    docker,
    `#!/bin/sh
if [ "$1" = pull ]; then
  echo "pull image: $2"
  echo "master: Pulling latest image"
  ${failure || "exit 0"}
fi
if [ "$1" = run ]; then
  printf '%s\\n' "$@" > "$DOCKER_ARGS_FILE"
fi
echo "container started" >&2
echo '{"ok":true}'
`,
    { mode: 0o700 },
  );
  await chmod(docker, 0o700);
  return { directory, dockerDirectory };
}
