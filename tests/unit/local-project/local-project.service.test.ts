import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InvalidRepoNameError,
  LocalProjectService,
  NoProjectError,
  ProjectAlreadyInitializedError,
  toToml,
} from '../../../src/contexts/local-project';

describe('local-project/local-project.service (unit)', () => {
  it('init() writes a .deltix/config.toml binding at the project root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deltix-proj-'));
    const service = new LocalProjectService();

    const project = await service.init(root, 'acme-widgets');

    expect(project.root).toBe(root);
    expect(project.config.repo).toBe('acme-widgets');
    expect(project.config.branch).toBe('main');
    expect(project.configPath.endsWith(join('.deltix', 'config.toml'))).toBe(true);

    const raw = await readFile(project.configPath, 'utf8');
    expect(raw).toContain('repo = "acme-widgets"');

    await rm(root, { recursive: true, force: true });
  });

  it('resolve() walks up from a nested working directory to the project root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deltix-proj-'));
    const nested = join(root, 'src', 'deep');
    await mkdir(nested, { recursive: true });
    const service = new LocalProjectService();
    await service.init(root, 'acme-widgets');

    const project = await service.resolve(nested);

    expect(project.root).toBe(root);
    expect(project.config.repo).toBe('acme-widgets');

    await rm(root, { recursive: true, force: true });
  });

  it('resolve() throws NoProjectError when no binding exists in any ancestor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deltix-proj-'));
    const service = new LocalProjectService();
    await expect(service.resolve(root)).rejects.toBeInstanceOf(NoProjectError);
    await rm(root, { recursive: true, force: true });
  });

  it('init() refuses to re-initialize inside an existing project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deltix-proj-'));
    const nested = join(root, 'sub');
    await mkdir(nested, { recursive: true });
    const service = new LocalProjectService();
    await service.init(root, 'acme-widgets');

    await expect(service.init(nested, 'other')).rejects.toBeInstanceOf(
      ProjectAlreadyInitializedError,
    );

    await rm(root, { recursive: true, force: true });
  });

  it('init() rejects an invalid repo name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deltix-proj-'));
    const service = new LocalProjectService();
    await expect(service.init(root, 'bad name!')).rejects.toBeInstanceOf(InvalidRepoNameError);
    await rm(root, { recursive: true, force: true });
  });

  it('setBranch() updates the stored branch to default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deltix-proj-'));
    const service = new LocalProjectService();
    await service.init(root, 'acme-widgets');

    const updated = await service.setBranch(root, 'develop');

    expect(updated.config.branch).toBe('develop');
    const resolved = await service.resolve(root);
    expect(resolved.config.branch).toBe('develop');

    await rm(root, { recursive: true, force: true });
  });

  it('toToml() round-trips through the schema', async () => {
    const config = { repo: 'acme-widgets', branch: 'main', created_at: 123 } as const;
    const toml = toToml(config);
    expect(toml).toContain('repo = "acme-widgets"');
  });
});
