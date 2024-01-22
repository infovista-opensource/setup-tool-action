import * as fs from "fs";
import * as core from "@actions/core";
import * as tc from "@actions/tool-cache";
import * as os from "os";
import * as path from "path";
import * as github from "./github";
import { interpolate } from "./interpolate";
import { type Platform, type Arch, getInputs } from "./inputs";

type PkgExtension = "tar.gz" | "zip" | "7z" | "xar";

type Extract = (archivePath: string, toDir: string) => Promise<string>;

function getExtract(ext: PkgExtension): Extract | null {
  switch (ext) {
    case "tar.gz":
      return tc.extractTar;
    case "zip":
      return tc.extractZip;
    case "7z":
      return tc.extract7z;
    case "xar":
      return tc.extractXar;
  }
}

interface ToolConfig {
  name: string;
  version: string;
  arch: Arch;
  targetDir: string | null;
}

interface ArchiveConfig {
  url: string;
  subdir: string | null;
  extract: Extract | null;
}

interface ReleaseConfig {
  tool: ToolConfig;
  archive: ArchiveConfig;
  githubToken: string | null;
}

function mkReleaseConfig(platform: Platform, osArch: Arch): ReleaseConfig {
  const {
    name,
    version,
    url: urlTemplate,
    subdir: subdirTemplate,
    os,
    arch,
    ext,
    noExtract,
    githubToken,
    targetDir
  } = getInputs(platform, osArch, core);

  const templateVars = { name, version, os, arch, ext };
  const url = interpolate(urlTemplate, templateVars);
  const subdir = subdirTemplate ? interpolate(subdirTemplate, templateVars) : null;

  return {
    tool: {
      name,
      version,
      arch: osArch,
      targetDir: targetDir,
    },
    archive: {
      url,
      subdir,
      extract: noExtract ? null : getExtract(ext as PkgExtension),
    },
    githubToken,
  };
}

async function download(releaseConfig: ReleaseConfig): Promise<string> {
  const { tool, archive, githubToken } = releaseConfig;
  const { subdir, extract } = archive;

  core.debug(`url: ${archive.url}`);
  core.debug(`github-token ${githubToken ? "present" : "not present"}`);

  const { url, auth, headers } = githubToken
    ? await core.group("Handling as private GitHub URL", async () => {
        return await github.findReleaseAsset(archive.url, githubToken);
      })
    : { url: archive.url, auth: undefined, headers: undefined };

  /*
    in container-driven jobs, to avoid file ownership issues on self-hosted runners,
    save directly the binary to ~/.local/bin (that will be added to $PATH)
  */
  const useToolCache:boolean = (tool.targetDir === undefined) || (tool.targetDir == null)
  var destDir: string;
  if (useToolCache) {
    core.info(`Setting up ${tool.name}/${tool.arch}@${tool.version} in tool cache`);
    destDir = path.join(os.homedir(), "tmp", Math.random().toString(36).slice(2) );
  } else {
    core.info(`Setting up ${tool.name}/${tool.arch}@${tool.version} in dir=${tool.targetDir}`);
    destDir = tool.targetDir || path.join(os.homedir(), "local", "bin");
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
  }
  return core.group(`Downloading ${tool.name} from ${url}`, async () => {
    // directly download executable
    if (!extract) {
      const dest = path.join(destDir, tool.name)
      core.info(`Downloading without extraction to ${dest}`);
      await tc.downloadTool(url, dest, auth, headers);
      core.debug(`setting executable flag to ${dest}`);
      fs.chmodSync(dest, "755");
      if (useToolCache) {
        // let tool-cache do its job
        core.debug(`caching dir=${destDir} tool=${tool.name} v=${tool.version} arch=${tool.arch}`);
        const ret = await tc.cacheDir(destDir, tool.name, tool.version, tool.arch);
        core.debug(`removing ${destDir}`)
        fs.rmSync(destDir, { recursive: true, force: true });
        return ret;
      } else {
        // the file is already in the target dir, just return it
        return Promise.resolve(dest);
      }
    }
    // download archive and get tool inside it
    core.info("Downloading with archive extraction");
    const archivePath = await tc.downloadTool(url, undefined, auth, headers); // dest=undefined creates tempdir for download
    core.debug(`downloaded to archivePath=${archivePath}`);
    const archiveDest = path.join(os.homedir(), "tmp", Math.random().toString(36).slice(2));
    core.debug(`extracting to archiveDest=${archiveDest}`);
    const extracted = await extract(archivePath, archiveDest);
    const releaseFolder = subdir ? path.join(extracted, subdir) : extracted;
    core.debug(`releaseFolder=${archiveDest}`);
    if (!useToolCache) {
      // in container, just copy the extracted directory to the final destination
      core.debug(`copying ${archiveDest} to ${destDir}`);
      fs.cpSync(releaseFolder, destDir);
      core.debug(`removing ${archiveDest}`)
      fs.rmSync(archiveDest, { recursive: true, force: true });
      core.debug(`removing ${archivePath}`)
      fs.rmSync(archivePath, { recursive: true, force: true });
      return Promise.resolve(path.join(destDir, tool.name));
    } else {
      // non-container: tool-ize the extracted directory
      core.debug(`caching dir=${releaseFolder} tool=${tool.name} v=${tool.version} arch=${tool.arch}`);
      const ret = await tc.cacheDir(releaseFolder, tool.name, tool.version, tool.arch );
      core.debug(`removing ${archiveDest}`)
      fs.rmSync(archiveDest, { recursive: true, force: true });
      core.debug(`removing ${archivePath}`)
      fs.rmSync(archivePath, { recursive: true, force: true });
      return ret;
    }
  });
}

async function findOrDownload(releaseConfig: ReleaseConfig): Promise<string> {
  const { tool, archive } = releaseConfig;
  const { url } = archive;
  const existingDir = await tc.find(tool.name, tool.version, tool.arch);

  if (existingDir) {
    core.debug(`Found cached ${tool.name} at ${existingDir}`);
    return existingDir;
  } else {
    core.debug(`${tool.name} not cached, so attempting to download from ${url}`);
    return await download(releaseConfig);
  }
}

async function run() {
  try {
    const config = mkReleaseConfig(process.platform, process.arch as Arch);
    const dir = await findOrDownload(config);
    core.debug(`adding ${dir} to path`);
    core.addPath(dir);
    core.info(`${config.tool.name} ${config.tool.version} is now set up at ${dir}`);
  } catch (error) {
    core.setFailed(error instanceof Error ? error : String(error));
  }
}

run();
