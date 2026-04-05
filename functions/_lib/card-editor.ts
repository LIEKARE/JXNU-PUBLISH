/// <reference types="@cloudflare/workers-types" />

import YAML from 'yaml';

export interface EditorEnv {
  GITHUB_EDITOR_TOKEN: string;
  GITHUB_REPO_OWNER: string;
  GITHUB_REPO_NAME: string;
  GITHUB_EDITOR_BRANCH?: string;
  EDITOR_ACCESS_KEY?: string;
}

export type EditorAttachment = {
  name: string;
  url: string;
  type?: string;
  pendingUpload?: {
    contentType?: string;
    base64: string;
  };
};

export type EditorDraft = {
  guid: string;
  schoolSlug: string;
  title: string;
  description: string;
  markdown: string;
  attachments: EditorAttachment[];
};

type GitHubFile = {
  sha: string;
  content: string;
};

type GithubTreeEntry = {
  path: string;
  mode: '100644';
  type: 'blob';
  sha: string | null;
};

const json = (value: string) => JSON.stringify(value);

function requireEditorAccess(request: Request, env: EditorEnv) {
  const expected = String(env.EDITOR_ACCESS_KEY || '').trim();
  if (!expected) return null;
  const actual = String(request.headers.get('x-editor-key') || '').trim();
  if (actual && actual === expected) return null;
  return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
}

function getBranch(env: EditorEnv) {
  return String(env.GITHUB_EDITOR_BRANCH || 'test').trim() || 'test';
}

function normalizeGuid(value: string) {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error('无效卡片 ID');
  }
  return trimmed;
}

function normalizeSchoolSlug(value: string) {
  const trimmed = String(value || '').trim();
  if (!/^[a-z0-9-]+$/i.test(trimmed)) {
    throw new Error('无效学院标识');
  }
  return trimmed;
}

function sanitizeFileName(name: string) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || `attachment-${Date.now()}`;
}

function normalizeAttachmentUrl(url: string) {
  const trimmed = String(url || '').trim();
  if (!trimmed) throw new Error('附件地址不能为空');
  if (trimmed.includes('..')) throw new Error('附件地址非法');
  return trimmed;
}

function decodeBase64(base64: string) {
  const clean = String(base64 || '').replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeBase64Text(base64: string) {
  return new TextDecoder().decode(decodeBase64(base64));
}

function foldBlock(value: string) {
  const lines = String(value || '').replace(/\r\n/g, '\n').split('\n');
  if (!lines.length) return '  ';
  return lines.map((line) => `  ${line}`).join('\n');
}

function buildFrontmatter(data: Record<string, unknown>) {
  const attachments = Array.isArray(data.attachments) ? data.attachments as EditorAttachment[] : [];
  const tags = Array.isArray(data.tags) ? data.tags : [];
  const source = (data.source && typeof data.source === 'object') ? data.source as Record<string, unknown> : {};
  const lines = [
    '---',
    `title: ${json(String(data.title || ''))}`,
    'description: >-',
    foldBlock(String(data.description || '')),
    `category: ${json(String(data.category || '其它分类'))}`,
    `tags: [${tags.map((item) => json(String(item))).join(', ')}]`,
    `start_at: ${json(String(data.start_at || ''))}`,
    `end_at: ${json(String(data.end_at || ''))}`,
    `id: ${json(String(data.id || ''))}`,
    `school_slug: ${json(String(data.school_slug || ''))}`,
    `published: ${json(String(data.published || ''))}`,
    `pinned: ${Boolean(data.pinned) ? 'true' : 'false'}`,
    `cover: ${json(String(data.cover || ''))}`,
    `badge: ${json(String(data.badge || ''))}`,
    `extra_url: ${json(String(data.extra_url || ''))}`,
    'source:',
    `  channel: ${json(String(source.channel || ''))}`,
    `  sender: ${json(String(source.sender || ''))}`,
  ];

  if (!attachments.length) {
    lines.push('attachments: []');
  } else {
    lines.push('attachments:');
    for (const attachment of attachments) {
      lines.push(`  - name: ${json(attachment.name)}`);
      lines.push(`    url: ${json(attachment.url)}`);
      if (attachment.type) {
        lines.push(`    type: ${json(attachment.type)}`);
      }
    }
  }

  lines.push('---');
  return lines.join('\n');
}

function parseCard(raw: string) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error('卡片格式不正确');
  }
  const data = YAML.parse(match[1]) as Record<string, unknown>;
  const markdown = String(match[2] || '').replace(/^\n+/, '');
  return { data, markdown };
}

function normalizeAttachments(value: unknown): EditorAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new Error('附件格式不正确');
    }
    const current = item as Record<string, unknown>;
    const name = String(current.name || '').trim();
    const url = normalizeAttachmentUrl(String(current.url || '').trim());
    const type = String(current.type || '').trim();
    const pendingUpload = current.pendingUpload && typeof current.pendingUpload === 'object'
      ? {
          contentType: String((current.pendingUpload as Record<string, unknown>).contentType || '').trim() || undefined,
          base64: String((current.pendingUpload as Record<string, unknown>).base64 || '').trim(),
        }
      : undefined;
    if (!name) throw new Error('附件名称不能为空');
    if (pendingUpload?.base64) {
      return { name, url, type: type || undefined, pendingUpload };
    }
    return type ? { name, url, type } : { name, url };
  });
}

async function githubFetch<T>(env: EditorEnv, pathname: string, init?: RequestInit): Promise<T> {
  const token = String(env.GITHUB_EDITOR_TOKEN || '').trim();
  const owner = String(env.GITHUB_REPO_OWNER || '').trim();
  const repo = String(env.GITHUB_REPO_NAME || '').trim();
  if (!token || !owner || !repo) {
    throw new Error('缺少 GitHub 编辑环境变量');
  }

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}${pathname}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'jxnu-publish-card-editor',
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${response.status}: ${text.slice(0, 200)}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return response.json<T>();
}

async function getRepoFile(env: EditorEnv, repoPath: string): Promise<GitHubFile> {
  const branch = encodeURIComponent(getBranch(env));
  const data = await githubFetch<{ sha: string; content: string }>(
    env,
    `/contents/${repoPath}?ref=${branch}`,
  );
  return {
    sha: data.sha,
    content: decodeBase64Text(String(data.content || '').replace(/\n/g, '')),
  };
}

export async function loadDraftFromGitHub(env: EditorEnv, guid: string, schoolSlug: string): Promise<EditorDraft> {
  const safeGuid = normalizeGuid(guid);
  const safeSchool = normalizeSchoolSlug(schoolSlug);
  const repoPath = `content/card/${safeSchool}/${safeGuid}.md`;
  const file = await getRepoFile(env, repoPath);
  const parsed = parseCard(file.content);
  return {
    guid: safeGuid,
    schoolSlug: safeSchool,
    title: String(parsed.data.title || '').trim(),
    description: String(parsed.data.description || '').trim(),
    markdown: parsed.markdown,
    attachments: normalizeAttachments(parsed.data.attachments || []),
  };
}

async function getBranchHead(env: EditorEnv) {
  const branch = encodeURIComponent(getBranch(env));
  return githubFetch<{ object: { sha: string } }>(env, `/git/ref/heads/${branch}`);
}

async function getCommit(env: EditorEnv, sha: string) {
  return githubFetch<{ tree: { sha: string } }>(env, `/git/commits/${sha}`);
}

async function createBlob(env: EditorEnv, content: string, encoding: 'utf-8' | 'base64') {
  const data = await githubFetch<{ sha: string }>(env, '/git/blobs', {
    method: 'POST',
    body: JSON.stringify({ content, encoding }),
  });
  return data.sha;
}

async function createTree(env: EditorEnv, baseTree: string, tree: GithubTreeEntry[]) {
  const data = await githubFetch<{ sha: string }>(env, '/git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTree, tree }),
  });
  return data.sha;
}

async function createCommit(env: EditorEnv, message: string, tree: string, parent: string) {
  const data = await githubFetch<{ sha: string }>(env, '/git/commits', {
    method: 'POST',
    body: JSON.stringify({ message, tree, parents: [parent] }),
  });
  return data.sha;
}

async function updateRef(env: EditorEnv, sha: string) {
  const branch = encodeURIComponent(getBranch(env));
  await githubFetch(env, `/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha, force: false }),
  });
}

export async function saveDraftToGitHub(env: EditorEnv, payload: EditorDraft) {
  const safeGuid = normalizeGuid(payload.guid);
  const safeSchool = normalizeSchoolSlug(payload.schoolSlug);
  const cardPath = `content/card/${safeSchool}/${safeGuid}.md`;
  const currentFile = await getRepoFile(env, cardPath);
  const parsed = parseCard(currentFile.content);
  const previousAttachments = normalizeAttachments(parsed.data.attachments || []);
  const rawNextAttachments = normalizeAttachments(payload.attachments || []);

  const nextAttachments: EditorAttachment[] = [];
  const treeEntries: GithubTreeEntry[] = [];
  for (const attachment of rawNextAttachments) {
    if (attachment.pendingUpload?.base64) {
      const outputName = `${Date.now()}-${sanitizeFileName(attachment.name)}`;
      const repoPath = `content/attachments/manual/${safeGuid}/${outputName}`;
      const blobSha = await createBlob(env, attachment.pendingUpload.base64, 'base64');
      treeEntries.push({ path: repoPath, mode: '100644', type: 'blob', sha: blobSha });
      nextAttachments.push({
        name: attachment.name,
        url: `/attachments/manual/${safeGuid}/${outputName}`,
        type: attachment.type,
      });
      continue;
    }
    nextAttachments.push({ name: attachment.name, url: attachment.url, type: attachment.type });
  }

  const nextUrls = new Set(nextAttachments.map((item) => item.url));
  for (const attachment of previousAttachments) {
    const removablePrefix = `/attachments/manual/${safeGuid}/`;
    if (!attachment.url.startsWith(removablePrefix)) continue;
    if (nextUrls.has(attachment.url)) continue;
    treeEntries.push({
      path: `content/${attachment.url.replace(/^\//, '')}`,
      mode: '100644',
      type: 'blob',
      sha: null,
    });
  }

  const nextData = {
    ...parsed.data,
    title: String(payload.title || '').trim(),
    description: String(payload.description || '').trim(),
    attachments: nextAttachments,
  };
  const frontmatter = buildFrontmatter(nextData);
  const markdown = String(payload.markdown || '').replace(/\r\n/g, '\n').trimEnd();
  const cardContent = `${frontmatter}\n\n${markdown}\n`;
  const cardBlobSha = await createBlob(env, cardContent, 'utf-8');
  treeEntries.push({ path: cardPath, mode: '100644', type: 'blob', sha: cardBlobSha });

  const head = await getBranchHead(env);
  const baseCommitSha = head.object.sha;
  const baseCommit = await getCommit(env, baseCommitSha);
  const treeSha = await createTree(env, baseCommit.tree.sha, treeEntries);
  const commitSha = await createCommit(env, `edit(card): update ${safeGuid}`, treeSha, baseCommitSha);
  await updateRef(env, commitSha);
}

export function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(`${JSON.stringify(payload)}\n`, {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(init?.headers || {}),
    },
  });
}

export function withEditorAuth(request: Request, env: EditorEnv) {
  return requireEditorAccess(request, env);
}
