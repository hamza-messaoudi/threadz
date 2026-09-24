import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify, classifyBash, type GateConfig } from '../server/gate/classify.ts';
import { compileGate } from '../server/gate/compile.ts';
import { tmpDir } from './helpers.ts';

const gate: GateConfig = compileGate({ servers: { tracker: 'azure-devops' }, allow: ['mcp__notion__*search*'], deny: ['mcp__ado__pipelines_artifact'], bash: { extraAllow: ['kubectl get', 'kubectl describe'] } });
const ro = (tool: string, input: unknown = {}, agentTools: string[] = []) => classify(tool, input, { mode: 'readonly', agentTools, gate, cwd: '/repo' }).allow;

describe('built-in tools', () => {
  it.each([
    ['Read', true], ['Grep', true], ['Glob', true], ['LS', true], ['WebSearch', true], ['WebFetch', true], ['TodoWrite', true],
    ['Skill', true], ['NotebookRead', true], ['BashOutput', true], ['Task', true], ['Agent', true], ['ToolSearch', true],
    ['Write', false], ['Edit', false], ['MultiEdit', false], ['NotebookEdit', false], ['KillShell', false], ['TaskStop', false],
    ['CronCreate', false], ['EnterWorktree', false], ['SomeFutureTool', false],
  ])('%s -> %s', (tool, expected) => expect(ro(tool)).toBe(expected));
});

describe('Azure DevOps profile', () => {
  it.each([
    ['wit_work_item', true], ['wit_query', true], ['repo_pull_request', true], ['repo_file', true], ['pipelines_build', true],
    ['wiki', true], ['search_code', true], ['search_workitem', true], ['core_list_projects', true],
    ['wit_work_item_write', false], ['repo_pull_request_write', false], ['repo_create_branch', false], ['wiki_upsert_page', false],
    ['wit_create_work_item', false], ['repo_update_pull_request', false], ['wit_add_work_item_comment', false], ['wit_link_work_item_to_pull_request', false],
    ['repo_vote_pull_request', false], ['repo_reply_to_comment', false], ['pipelines_run_pipeline', false], ['build_queue_build', false],
    ['wit_delete_work_item', false], ['wit_unlink_work_item', false], ['create_work_item', false],
  ])('mcp__ado__%s -> %s', (tool, expected) => expect(ro(`mcp__ado__${tool}`)).toBe(expected));

  it('checks the action parameter as defence in depth', () => {
    expect(ro('mcp__ado__wit_work_item', { action: 'get' })).toBe(true);
    expect(ro('mcp__ado__wit_work_item', { action: 'list_by_ids' })).toBe(true);
    expect(ro('mcp__ado__wit_work_item', { action: 'search' })).toBe(true);
    expect(ro('mcp__ado__repo_pull_request', { action: 'my' })).toBe(true);
    expect(ro('mcp__ado__repo_file', { action: 'download' })).toBe(true);
    expect(ro('mcp__ado__repo_pull_request', { action: 'show_threads' })).toBe(true);
    expect(ro('mcp__ado__wit_work_item', { action: 'create' })).toBe(false);
    expect(ro('mcp__ado__wit_work_item', { action: 'transition' })).toBe(false);
  });

  it('detects the profile from the server name, including configured and plugin names', () => {
    expect(ro('mcp__azure-devops__wit_query')).toBe(true);
    expect(ro('mcp__plugin_x_devops__wit_create_work_item')).toBe(false);
    expect(ro('mcp__tracker__wit_query')).toBe(true); // mapped in readonly.yaml
    expect(ro('mcp__shadow__get_thing')).toBe(false); // "ado" inside a word is not ADO
  });
  it('readonly.yaml deny beats the profile', () => expect(ro('mcp__ado__pipelines_artifact')).toBe(false));
});

describe('GitHub profile', () => {
  it.each([
    ['get_me', true], ['get_file_contents', true], ['list_pull_requests', true], ['search_code', true], ['issue_read', true], ['pull_request_read', true],
    ['create_issue', false], ['update_pull_request', false], ['merge_pull_request', false], ['push_files', false], ['delete_file', false],
    ['add_issue_comment', false], ['issue_write', false], ['fork_repository', false], ['request_copilot_review', false], ['assign_copilot_to_issue', false],
    ['create_pull_request_review', false],
  ])('mcp__github__%s -> %s', (tool, expected) => expect(ro(`mcp__github__${tool}`)).toBe(expected));
  it('works for plugin server names', () => expect(ro('mcp__plugin_engineering_github__list_issues')).toBe(true));
});

describe('other MCP servers', () => {
  it('denies unknown servers unless listed', () => {
    expect(ro('mcp__notion__notion-fetch')).toBe(false);
    expect(ro('mcp__notion__notion-search')).toBe(true); // readonly.yaml allow glob
    expect(ro('mcp__random__anything')).toBe(false);
  });
});

describe('Bash allowlist', () => {
  it.each([
    ['ls -la', true], ['cat src/app.ts', true], ['head -n 20 README.md', true], ['tail -f log.txt', true], ['wc -l *.ts', true],
    ['rg foo', true], ['rg foo | head', true], ['grep -rn "TODO" src', true], ['pwd', true], ['tree -L 2', true], ['jq . package.json', true],
    ['stat x', true], ['file x', true], ['du -sh .', true], ['which node', true], ['echo hello', true], ['find . -name "*.ts"', true],
    ['cat a.txt 2>/dev/null', true], ['ls 2>&1', true], ['rg foo | sort', false], ['cat x | wc -l | head -1', true],
    ['cd x && ls', false], ['ls; rm -rf /', false], ['ls || true', false], ['sleep 1 &', false], ['echo hi > file.txt', false],
    ['cat >> file', false], ['echo $(whoami)', false], ['echo `id`', false], ['diff <(ls a) <(ls b)', false], ['(ls)', false],
    ['FOO=bar ls', false], ['rm -rf node_modules', false], ['find . -delete', false], ['find . -exec rm {} ;', false], ['find . -execdir ls ;', false],
    ['find . -ok rm {} ;', false], ['find . -fprint out', false], ['rg --pre ./evil foo', false], ['tree -o out.txt', false], ['npm test', false],
    ['git status', true], ['git log --oneline -5', true], ['git diff HEAD~1', true], ['git show abc', true], ['git blame x.ts', true],
    ['git rev-parse HEAD', true], ['git ls-files', true], ['git remote -v', true], ['git tag -l', true], ['git branch', true], ['git branch -a', true],
    ['git branch -r -v', true], ['git -C ../other status', true], ['git --no-pager log', true],
    ['git fetch', false], ['git pull', false], ['git checkout main', false], ['git switch x', false], ['git commit -m x', false], ['git push', false],
    ['git reset --hard', false], ['git branch -d x', false], ['git branch -D x', false], ['git branch -m a b', false], ['git branch newbranch', false],
    ['git remote add x y', false], ['git tag v1', false], ['git -c core.pager=evil log', false], ['git log --output=file', false],
    ['gh pr view 12', true], ['gh pr list', true], ['gh pr diff 3', true], ['gh pr checks 3', true], ['gh pr status', true], ['gh issue view 3', true],
    ['gh issue list', true], ['gh repo view', true], ['gh run list', true], ['gh run view 5 --log', true], ['gh workflow list', true], ['gh release list', true],
    ['gh search prs foo', true], ['gh label list', true], ['gh auth status', true],
    ['gh api repos/o/r/pulls', true], ['gh api -X GET repos/o/r', true], ['gh api --method=GET repos/o/r', true],
    ['gh pr create', false], ['gh pr merge 3', false], ['gh pr comment 3 -b x', false], ['gh pr review 3', false], ['gh pr checkout 3', false], ['gh pr edit 3', false],
    ['gh issue create', false], ['gh issue comment 3', false], ['gh issue edit 3', false], ['gh issue close 3', false], ['gh run rerun 5', false], ['gh run cancel 5', false],
    ['gh workflow run ci', false], ['gh release create v1', false],
    ['gh api -X POST repos/o/r/issues', false], ['gh api --method POST x', false], ['gh api -XPATCH x', false], ['gh api repos/o/r/issues -f title=x', false],
    ['gh api x -F a=1', false], ['gh api x --field a=1', false], ['gh api x --raw-field a=1', false], ['gh api x --input body.json', false], ['gh api graphql -f query=x', false],
    ['az devops project list', true], ['az devops team show --team x', true], ['az repos list', true], ['az repos pr list', true], ['az repos pr show --id 3', true],
    ['az repos pr reviewer list --id 3', true], ['az repos pr work-item list --id 3', true], ['az repos ref list', true], ['az boards work-item show --id 1', true],
    ['az boards query --wiql x', true], ['az boards iteration project list', true], ['az boards area team list --team x', true], ['az pipelines list', true],
    ['az pipelines runs list', true], ['az pipelines build show --id 2', true], ['az account show', true],
    ['az rest --uri x', false], ['az devops invoke --area x', false], ['az repos pr create', false], ['az repos pr update --id 3', false], ['az repos pr set-vote --vote approve', false],
    ['az boards work-item create --title x', false], ['az boards work-item update --id 1', false], ['az boards work-item delete --id 1', false], ['az pipelines run --name x', false],
    ['kubectl get pods', true], ['kubectl describe pod x', true], ['kubectl delete pod x', false],
  ])('%s -> %s', (cmd, expected) => expect(ro('Bash', { command: cmd })).toBe(expected));

  it('explains compound commands with the working directory', () => {
    const d = classifyBash('cd x && ls', [], '/repo');
    expect(d.reason).toBe('read-only mode: run one command at a time; you are already in /repo.');
  });
});

describe('modes and agent tools', () => {
  it('YOLO allows writes but still enforces the agent tools list', () => {
    expect(classify('Write', {}, { mode: 'yolo', agentTools: [], gate }).allow).toBe(true);
    expect(classify('Bash', { command: 'rm -rf x' }, { mode: 'yolo', agentTools: [], gate }).allow).toBe(true);
    expect(classify('Write', {}, { mode: 'yolo', agentTools: ['Read', 'mcp__ado__*'], gate }).allow).toBe(false);
    expect(classify('mcp__ado__wit_work_item_write', {}, { mode: 'yolo', agentTools: ['Read', 'mcp__ado__*'], gate }).allow).toBe(true);
    expect(classify('ToolSearch', {}, { mode: 'readonly', agentTools: ['Read'], gate }).allow).toBe(true);
    expect(ro('Read', {}, ['Grep'])).toBe(false);
  });
  it('an unknown mode denies', () => expect(classify('Read', {}, { mode: 'weird' as any, agentTools: [], gate }).allow).toBe(false));
});

describe('hook process', () => {
  const dir = tmpDir();
  const gateFile = path.join(dir, 'gate.json');
  fs.writeFileSync(gateFile, JSON.stringify(gate));
  const run = (payload: unknown, env: Record<string, string | undefined>) => {
    const e: Record<string, string> = { PATH: process.env.PATH!, AGENT_CHAT_GATE_CONFIG: gateFile, AGENT_CHAT_HOOK_LOG: path.join(dir, 'hook.log') };
    for (const [k, v] of Object.entries(env)) if (v !== undefined) e[k] = v;
    return spawnSync(process.execPath, ['dist/hook.mjs'], { input: JSON.stringify(payload), env: e, encoding: 'utf8' });
  };

  it('allows reads (exit 0) and denies writes with exit 2 and a reason on stderr', () => {
    expect(run({ tool_name: 'Read', tool_input: {} }, { AGENT_MODE: 'readonly' }).status).toBe(0);
    const w = run({ tool_name: 'Write', tool_input: {} }, { AGENT_MODE: 'readonly' });
    expect(w.status).toBe(2);
    expect(w.stderr).toContain('read-only mode');
    expect(run({ tool_name: 'Write', tool_input: {} }, { AGENT_MODE: 'yolo' }).status).toBe(0);
  });
  it('blocks when the hook throws', () => {
    const r = run({ tool_name: 'Read', tool_input: {} }, { AGENT_MODE: 'readonly', AGENT_CHAT_HOOK_TEST_THROW: '1' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('gate error');
  });
  it('blocks writes (and everything) when AGENT_MODE is missing', () => {
    expect(run({ tool_name: 'Write', tool_input: {} }, {}).status).toBe(2);
    expect(run({ tool_name: 'Read', tool_input: {} }, {}).status).toBe(2);
  });
  it('blocks on unreadable config and on garbage input', () => {
    expect(run({ tool_name: 'Read', tool_input: {} }, { AGENT_MODE: 'readonly', AGENT_CHAT_GATE_CONFIG: '/nope.json' }).status).toBe(2);
    const r = spawnSync(process.execPath, ['dist/hook.mjs'], { input: 'not json', env: { AGENT_MODE: 'yolo', AGENT_CHAT_GATE_CONFIG: gateFile }, encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
  it('logs every decision with the run id', () => {
    run({ tool_name: 'Grep', tool_input: {} }, { AGENT_MODE: 'readonly', AGENT_CHAT_RUN_ID: 'run-42' });
    const lines = fs.readFileSync(path.join(dir, 'hook.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.some((l) => l.run === 'run-42' && l.tool === 'Grep' && l.allow === true)).toBe(true);
  });
});
