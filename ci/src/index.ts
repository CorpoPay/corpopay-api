import { dag, Directory, Secret, object, func } from "@dagger.io/dagger"

/**
 * CorpoPay API — Dagger CI module.
 *
 * Single source of truth for the portable quality gate (check) and the image
 * build/publish (publish). Both GitHub Actions and GitLab CI invoke these so
 * they stop maintaining divergent check definitions.
 */
@object()
export class CorpopayApi {
  /**
   * Run the quality gate: install → prisma generate → typecheck → lint → test.
   */
  @func()
  async check(src: Directory): Promise<string> {
    return dag
      .container()
      .from("node:24-slim")
      .withExec(["apt-get", "update", "-y"])
      .withExec(["apt-get", "install", "-y", "openssl"])
      .withMountedDirectory("/src", src)
      .withWorkdir("/src")
      .withExec(["npm", "ci"])
      .withExec(["npx", "prisma", "generate"])
      .withExec(["npm", "run", "typecheck"])
      .withExec(["npm", "run", "lint"])
      .withExec(["npm", "run", "test"])
      .stdout()
  }

  /**
   * Build and publish the API image to GHCR.
   */
  @func()
  async publish(src: Directory, tag: string, registryPassword: Secret): Promise<string> {
    return dag
      .container()
      .build(src, { dockerfile: "Dockerfile" })
      .withRegistryAuth("ghcr.io", "corpopay", registryPassword)
      .publish(`ghcr.io/corpopay/corpopay-api:${tag}`)
  }
}
