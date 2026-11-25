export function normalizeInteractionReason(value: string, inlinePlaceholder: string): string {
  return value.trim()
    .replace(/^(?:是否允许(?:我)?|能否允许(?:我)?|请允许(?:我)?|can I\b|may I\b)\s*/i, '')
    .replace(/[？?]+$/, '')
    .replace(/```[\s\S]*?```|`[^`\r\n]+`/g, inlinePlaceholder)
    .replace(/\s+/g, ' ')
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1')
    .trim();
}

export function containsInteractionCommandSyntax(value: string): boolean {
  return /https?:\/\//i.test(value)
    || /[A-Za-z]:[\\/]/.test(value)
    || /(?:^|[\s（(“"'：:])(?:\.{1,2}[\\/]|\/)[^\s，。！？；]+/.test(value)
    || /(?:^|\s)--?[A-Za-z][\w-]*(?:[=\s]|$)/.test(value)
    || /\b(?:token|secret|password|passwd|api[_-]?key|authorization)=\S+/i.test(value)
    || /\b(?:npm|pnpm|yarn)\s+(?:run|install|ci|test|exec|start|build|add|remove|update|publish)\b/i.test(value)
    || /\bgit\s+(?:add|commit|diff|status|show|log|push|pull|merge|rebase|checkout|switch|worktree)\b/i.test(value)
    || /\b(?:node|python(?:3)?|mvn|curl|docker|kubectl|powershell|pwsh)\s+(?:[A-Za-z0-9./\\_-]|["'])/i.test(value)
    || /\b(?:SELECT|UPDATE|DELETE|INSERT|ALTER|DROP|CREATE)\b[\s\S]*\b(?:FROM|INTO|TABLE|SET|VALUES)\b/i.test(value)
    || /\b(?:Get|Set|New|Remove|Start|Stop|Invoke|Test)-[A-Za-z]+\s+\S+/i.test(value)
    || /\b(?:cat|ls|grep|rg|find|sed|awk|chmod|chown|rm|cp|mv|bash|sh)\s+\S+/i.test(value)
    || /\\\\[^\\\s]+\\[^\\\s]+/.test(value)
    || /&&|\|\|/.test(value);
}
