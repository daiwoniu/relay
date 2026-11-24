/** Break complete sentences while keeping links, closing quotes, and existing lines intact. */
export function formatHelpText(content: string): string {
  const breaks = /(?:https?:\/\/|www\.)[^\s。！？；，、：）】》〉」』”’]+|([。！？；]+|[!?;]+(?=[）」』】》〉”’"']*[ \t\p{Script=Han}]))([）」』】》〉”’"']*)[ \t]*(?=[^\s。！？；，、：!?;,)])/gu;
  return content.replace(breaks, (match, punctuation: string | undefined, closing: string | undefined) =>
    punctuation ? punctuation + (closing ?? '') + '\n' : match);
}
