import fs from 'node:fs';
import asyncFs from 'node:fs/promises';
import path from 'node:path';

const agentsTemplate = `# Relay 项目 AI 入口

本目录是 Relay 中登记的独立用户项目。Codex 从 Relay 源码仓库根目录启动时会同时合并根规则，因此本文件明确覆盖源码仓库根目录中仅适用于 Relay 开发的流程要求。

- 开始处理本工作区任务前，只读取并遵守同目录的 \`WORKBUDDY.md\`。
- 除非用户明确要求开发 Relay 源码，不得读取或写入源码仓库的 \`WORKBUDDY.md\`、\`ai/STATUS.md\`、\`ai/ACTIVE.md\`、\`ai/docs/\` 或 \`ai/session/\`。
- 不得使用源码仓库的任务登记、worktree、session 日志和 Git 提交或推送流程管理本工作区任务。
- 工作区外操作继续遵守同目录 \`WORKBUDDY.md\` 的确认和安全边界。

如果更深层目录存在更具体的规则文件，应同时遵守；更具体的规则可以补充当前规则，但不能降低安全边界。
`;

const workbuddyTemplate = `# Relay 项目规则

本目录是 Relay 中登记的独立项目。处理任务时采用平衡模式：明确、可逆且局限在当前项目内的操作可以直接实施；高影响、不可逆或越界操作必须先获得用户确认。

## 开始工作

- 先查看现有文件、说明和更具体的规则，不用未经验证的假设代替事实。
- 简单任务可以直接实施；复杂、跨文件或高影响任务先给出简短计划。
- 需求存在会显著改变结果的歧义时，先询问用户再继续。
- 只处理当前任务所需内容，不擅自扩大范围。

## 必须先确认的操作

执行下列操作前，说明目标、影响和风险，并等待用户明确确认：

- 删除、覆盖或难以恢复地修改用户文件。
- 大范围重构、批量移动或重命名文件。
- 读取或写入当前工作区之外的位置。
- 安装、删除或升级依赖，修改系统、账号、网络或全局工具配置。
- 启动、停止或重启长期运行的服务和进程。
- 向外部网站、服务或人员发送消息、文件或数据。
- 其他可能造成数据丢失、费用、公开发布或外部状态变化的操作。

## 实施纪律

- 保留用户已有修改，不覆盖与当前任务无关的内容。
- 优先采用范围最小、可回退的方案；发现阻塞或关键风险时及时说明。
- 处理过程和最终回复默认使用中文；代码、命令、文件名、技术标识和需要保留原文的错误信息除外。
- 不读取、展示、记录或提交密码、令牌、私钥等敏感信息；发现疑似秘密时停止传播并提醒用户。
- 未经用户明确要求，不创建复杂的任务管理、状态记录或每日工作日志体系。

## 验证与交付

- 修改后执行与改动范围和风险匹配的检查或测试。
- 无法验证时明确说明原因，禁止声称未经验证的结果已经成功。
- 交付时说明完成内容、修改的文件、验证结果、遗留问题，以及用户是否仍需执行命令。

更深层目录中的规则可以增加具体约束，但不能取消本文件规定的确认、安全、验证和敏感信息边界。
`;

const existingAgentsWorkbuddyTemplate = `# 默认工作区 AI 入口

开始处理本项目中的任何任务前，必须完整阅读并遵守同目录的 \`AGENTS.md\`。

如果更深层目录存在更具体的规则文件，应同时遵守；更具体的规则可以补充当前规则，但不能降低安全边界。
`;

function createReadmeTemplate(hadAgentsFile: boolean, hadWorkbuddyFile: boolean): string {
  const agentsDescription = hadAgentsFile
    ? '项目已有的 AI 规则文件，Relay 保留原内容。'
    : hadWorkbuddyFile
      ? 'Relay 新增的 AI 自动发现入口，引导 AI 阅读项目已有的 `WORKBUDDY.md`。'
      : 'Relay 新增的 AI 自动发现入口，引导 AI 阅读实际工作规则。';
  const workbuddyDescription = hadWorkbuddyFile
    ? '项目已有的规则文件，Relay 保留原内容。'
    : hadAgentsFile
      ? 'Relay 新增的兼容入口，只引导 AI 阅读项目已有的 `AGENTS.md`。'
      : 'Relay 新增的默认规则，包含平衡模式、安全边界、验证和交付规范。';

  return `# Relay 项目

这是 Relay 登记项目时自动补齐的基础说明，可用于快速开始日常 AI 任务。你可以重命名项目、创建子目录，并按自己的需要修改这里的规则。

## 基础文件

- \`AGENTS.md\`：${agentsDescription}
- \`WORKBUDDY.md\`：${workbuddyDescription}
- \`README.md\`：Relay 新增的项目基础文件说明。

Relay 首次登记或恢复项目时会补齐缺失的基础文件，但永远不会覆盖已有文件。默认项目还会在后端启动时检查并恢复缺失文件。你可以自由编辑这些文件。

## 快速开始

你可以直接向 AI 提出明确任务，例如：

- 整理本目录中的资料并生成摘要。
- 创建一个简单网页或脚本。
- 分析 CSV、表格或文本数据。
- 阅读现有项目并修复一个具体问题。

明确、可逆且局限在当前工作区内的任务可以直接执行。删除或覆盖文件、大范围修改、工作区外操作、安装依赖或改变外部状态等高影响行为，AI 应先向你确认。
`;
}

const readmeTemplate = createReadmeTemplate(false, false);

export const DEFAULT_WORKSPACE_TEMPLATES = {
  'AGENTS.md': agentsTemplate,
  'WORKBUDDY.md': workbuddyTemplate,
  'README.md': readmeTemplate,
} as const;

export type DefaultWorkspaceFilename = keyof typeof DEFAULT_WORKSPACE_TEMPLATES;

export interface DefaultWorkspaceFilesystem {
  writeFileSync(
    filePath: string,
    content: string,
    options: { encoding: 'utf8'; flag: 'wx' },
  ): void;
  statSync(filePath: string): Pick<fs.Stats, 'isFile'>;
}

const defaultFilesystem: DefaultWorkspaceFilesystem = {
  writeFileSync(filePath, content, options) {
    fs.writeFileSync(filePath, content, options);
  },
  statSync(filePath) {
    return fs.statSync(filePath);
  },
};

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createInitializationError(filePath: string, error: unknown): Error {
  return new Error(`初始化默认项目文件失败（${filePath}）：${errorMessage(error)}`);
}

function isExistingFile(
  filePath: string,
  filesystem: DefaultWorkspaceFilesystem,
): boolean {
  try {
    return filesystem.statSync(filePath).isFile();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw createInitializationError(filePath, error);
  }
}

export function ensureProjectFiles(
  projectPath: string,
  filesystem: DefaultWorkspaceFilesystem = defaultFilesystem,
): { created: DefaultWorkspaceFilename[] } {
  const created: DefaultWorkspaceFilename[] = [];
  const hadAgentsFile = isExistingFile(path.join(projectPath, 'AGENTS.md'), filesystem);
  const hadWorkbuddyFile = isExistingFile(path.join(projectPath, 'WORKBUDDY.md'), filesystem);

  for (const filename of Object.keys(DEFAULT_WORKSPACE_TEMPLATES) as DefaultWorkspaceFilename[]) {
    const filePath = path.join(projectPath, filename);
    const content = filename === 'WORKBUDDY.md' && hadAgentsFile
      ? existingAgentsWorkbuddyTemplate
      : filename === 'README.md'
        ? createReadmeTemplate(hadAgentsFile, hadWorkbuddyFile)
        : DEFAULT_WORKSPACE_TEMPLATES[filename];
    try {
      filesystem.writeFileSync(filePath, content, {
        encoding: 'utf8',
        flag: 'wx',
      });
      created.push(filename);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        try {
          if (filesystem.statSync(filePath).isFile()) continue;
        } catch (statError) {
          throw createInitializationError(filePath, statError);
        }
      }
      throw createInitializationError(filePath, error);
    }
  }

  return { created };
}

export const ensureDefaultWorkspaceFiles = ensureProjectFiles;

/** Native project initialization: create missing templates asynchronously without replacing user files. */
export async function ensureProjectFilesAsync(projectPath:string,assertExclusiveWriter:()=>Promise<void>){
  const root=await asyncFs.realpath(projectPath),identity=await asyncFs.stat(root,{bigint:true});
  if(!identity.isDirectory())throw new Error('项目目录无效');
  const current=async()=>{
    await assertExclusiveWriter();const fresh=await asyncFs.stat(projectPath,{bigint:true});
    if(!fresh.isDirectory()||fresh.dev!==identity.dev||fresh.ino!==identity.ino||await asyncFs.realpath(projectPath)!==root)throw new Error('项目目录已变化');
  };
  const existing=async(filename:string)=>{
    try{const stat=await asyncFs.lstat(path.join(root,filename));if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error('项目规则文件不是独立普通文件');return true;}
    catch(error){if(errorCode(error)==='ENOENT')return false;throw error;}
  };
  const hadAgents=await existing('AGENTS.md'),hadWorkbuddy=await existing('WORKBUDDY.md'),created:DefaultWorkspaceFilename[]=[];
  for(const filename of Object.keys(DEFAULT_WORKSPACE_TEMPLATES)as DefaultWorkspaceFilename[]){
    const content=filename==='WORKBUDDY.md'&&hadAgents?existingAgentsWorkbuddyTemplate:filename==='README.md'?createReadmeTemplate(hadAgents,hadWorkbuddy):DEFAULT_WORKSPACE_TEMPLATES[filename];
    await current();
    try{await asyncFs.writeFile(path.join(root,filename),content,{encoding:'utf8',flag:'wx'});created.push(filename);}
    catch(error){if(errorCode(error)==='EEXIST'&&await existing(filename))continue;throw createInitializationError(path.join(root,filename),error);}
  }
  return{created};
}
