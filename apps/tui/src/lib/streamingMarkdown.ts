const CODE_FENCE = /```/g;

function codeFenceCount(text: string): number {
  return text.match(CODE_FENCE)?.length ?? 0;
}

/**
 * Split streaming markdown into an immutable completed prefix and one mutable
 * tail block. Block boundaries follow blank lines outside code fences.
 */
export function splitStreamingMarkdown(text: string, stablePrefix: string): {
  stablePrefix: string;
  unstableSuffix: string;
} {
  if (!text.startsWith(stablePrefix)) {
    stablePrefix = "";
  }

  const tail = text.slice(stablePrefix.length);
  if (!tail) {
    return { stablePrefix, unstableSuffix: "" };
  }

  const blocks = tail.split("\n\n");
  if (blocks.length <= 1) {
    return { stablePrefix, unstableSuffix: tail };
  }

  const completedBlocks = blocks.slice(0, -1);
  const nextStable = stablePrefix + completedBlocks.join("\n\n") + "\n\n";
  const prefixFenceParity = codeFenceCount(nextStable) % 2;
  if (prefixFenceParity !== 0) {
    return { stablePrefix, unstableSuffix: tail };
  }

  return {
    stablePrefix: nextStable,
    unstableSuffix: blocks.at(-1) ?? "",
  };
}

const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /m;

export function hasMarkdownSyntax(text: string): boolean {
  const sample = text.length > 500 ? text.slice(0, 500) : text;
  return MD_SYNTAX_RE.test(sample);
}
