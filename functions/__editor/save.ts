/// <reference types="@cloudflare/workers-types" />

import {
  jsonResponse,
  saveDraftToGitHub,
  withEditorAuth,
  type EditorDraft,
  type EditorEnv,
} from '../_lib/card-editor';

export const onRequestPost: PagesFunction<EditorEnv> = async (context) => {
  const denied = withEditorAuth(context.request, context.env);
  if (denied) return denied;

  try {
    const body = await context.request.json<EditorDraft>();
    await saveDraftToGitHub(context.env, body);
    return jsonResponse({ ok: true });
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : '保存失败' }, { status: 500 });
  }
};
