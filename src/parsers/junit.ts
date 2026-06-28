/**
 * JUnit XML parser for solidus.
 *
 * Parses standard JUnit XML reports into TestRun format, supporting
 * output from pytest, jest-junit, Mocha JUnit reporter, Vitest, Go test,
 * Rust test, and any other framework that emits JUnit XML.
 *
 * Zero external dependencies. Uses a focused tag-based parser for the
 * well-known subset of XML that JUnit XML employs.
 *
 * Supported structures:
 *   <testsuites> / <testsuite> / <testcase> elements
 *   <failure>, <error>, <skipped> child elements
 *   Self-closing tags (e.g. <skipped/>)
 *   Attributes: name, classname, time, tests, failures, errors, skipped
 *   XML prolog, comments, CDATA (stripped for content matching)
 */

import { readFileSync } from "node:fs";
import type { TestRun, TestResult } from "../core/types.js";
import { ValidationError } from "../core/errors.js";

interface ParsedAttr {
  name: string;
  value: string;
}

interface ParsedTag {
  name: string;
  attrs: ParsedAttr[];
  content: string;
  selfClosing: boolean;
  end: number;
}

/**
 * Parse JUnit XML string into a TestRun object.
 *
 * @param input - Raw JUnit XML string
 * @param runId - Optional run ID (auto-generated if omitted)
 * @param commit - Optional git commit SHA
 * @param branch - Optional branch name
 * @param ciRunId - Optional CI run ID
 */
export function parseJunitXml(
  input: string,
  runId?: string,
  commit?: string,
  branch?: string,
  ciRunId?: string,
): TestRun {
  const results: TestResult[] = [];
  let testCount = 0;

  // Strip XML prolog and comments
  let clean = input.replace(/<\?xml[^?]*\?>/gi, "");
  clean = clean.replace(/<!--[\s\S]*?-->/g, "");
  // Strip CDATA sections — replace <![CDATA[...]]> with the text content
  clean = clean.replace(/<!\[CDATA\[([\s\S]*?)]]>/g, "$1");
  // Strip UTF-8 BOM if present
  if (clean.charCodeAt(0) === 0xFEFF) clean = clean.slice(1);

  // Normalize namespace prefixes: <ns:testsuite> → <testsuite>, </ns:testsuite> → </testsuite>
  clean = clean.replace(/(<\/?)(\w+):(\w+)/g, "$1$3");

  // Find all <testsuite> elements (top-level or wrapped in <testsuites>)
  // Also handle <testcase> at top level (flat JUnit format from some runners)
  let pos = 0;

  while (pos < clean.length) {
    const nextTag = findTag(clean, pos);
    if (!nextTag) break;

    if (nextTag.name === "testsuites") {
      // <testsuites> wrapper — parse its content for <testsuite> children
      parseTestsuitesContent(nextTag.content, results, testCount);
      pos = nextTag.end;
      continue;
    }

    if (nextTag.name === "testsuite") {
      // Regular <testsuite> — extract testcases from its content
      testCount += parseTestcases(nextTag.content, results);
      pos = nextTag.end;
      continue;
    }

    if (nextTag.name === "testcase") {
      // Flat JUnit format: <testcase> directly at root level
      const attrsStr = nextTag.attrs.map(a => `${a.name}="${a.value}"`).join(" ");
      if (nextTag.selfClosing) {
        testCount += parseTestcases(`<testcase ${attrsStr} />`, results);
      } else {
        testCount += parseTestcases(`<testcase ${attrsStr}>${nextTag.content}</testcase>`, results);
      }
      pos = nextTag.end;
      // Flat format usually has all testcases sibling at this level — one pass handles them
      break;
    }

    // Unknown tag — skip past it
    pos = nextTag.end;
  }

  if (results.length === 0) {
    // Check if input was valid XML at all
    if (!clean.trim()) {
      throw new ValidationError("Empty XML input — no test data to parse");
    }
    // Could be valid XML but with no testcase elements
  }

  return {
    id: runId || `junit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    results,
    commit: commit || process.env.GITHUB_SHA || process.env.CI_COMMIT_SHA || undefined,
    branch: branch || process.env.GITHUB_REF_NAME || process.env.CI_COMMIT_BRANCH || undefined,
    ciRunId: ciRunId || process.env.GITHUB_RUN_ID || process.env.CI_PIPELINE_ID || undefined,
  };
}

/**
 * Parse JUnit XML from a file path.
 */
export function parseJunitFile(
  filePath: string,
  runId?: string,
  commit?: string,
  branch?: string,
  ciRunId?: string,
): TestRun {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new ValidationError(`Cannot read JUnit XML file: ${filePath}`, err);
  }
  if (!content || content.trim().length === 0) {
    throw new ValidationError(`Empty JUnit XML file: ${filePath}`);
  }
  return parseJunitXml(content, runId, commit, branch, ciRunId);
}

// ---- Suite/case parsing helpers ----

/**
 * Parse testcases from a <testsuite> content string.
 * Returns the count of tests parsed.
 */
function parseTestcases(content: string, results: TestResult[]): number {
  let count = 0;
  let pos = 0;

  while (pos < content.length) {
    const caseTag = findTag(content, pos);
    if (!caseTag) break;

    if (caseTag.name !== "testcase") {
      pos = caseTag.end;
      continue;
    }

    // Extract testcase attributes with XML entity decoding
    const name = decodeXmlEntities(getAttr(caseTag.attrs, "name") ?? `testcase_${results.length}`);
    const classname = decodeXmlEntities(getAttr(caseTag.attrs, "classname") || "unknown");
    const timeStr = getAttr(caseTag.attrs, "time") || "0";

    // Determine status from child elements
    const childContent = caseTag.content;
    const hasFailure = /<failure[\s>]/i.test(childContent) || /<error[\s>]/i.test(childContent);
    const hasSkipped = /<skipped[\s/>]/i.test(childContent);

    let status: "pass" | "fail" | "skip";
    if (hasFailure) {
      status = "fail";
    } else if (hasSkipped) {
      status = "skip";
    } else {
      status = "pass";
    }

    // Extract error message from <failure> or <error>
    let error: string | undefined;
    if (hasFailure) {
      const errMsg = extractErrorMessage(childContent);
      if (errMsg) error = errMsg;
    }

    // Parse time to ms
    const timeSec = parseFloat(timeStr);
    const durationMs = Number.isFinite(timeSec) && timeSec >= 0
      ? Math.round(timeSec * 1000)
      : 0;

    results.push({
      name: name || `testcase_${results.length}`,
      file: classname,
      status,
      durationMs,
      error,
    });
    count++;

    pos = caseTag.end;
  }

  return count;
}

/**
 * Parse <testsuite> elements from inside a <testsuites> wrapper content.
 */
function parseTestsuitesContent(content: string, results: TestResult[], _startCount: number): void {
  let pos = 0;
  while (pos < content.length) {
    const suiteTag = findTag(content, pos);
    if (!suiteTag) break;

    if (suiteTag.name !== "testsuite") {
      pos = suiteTag.end;
      continue;
    }

    parseTestcases(suiteTag.content, results);
    pos = suiteTag.end;
  }
}

// ---- XML parsing helpers ----

/**
 * Find the next XML tag at or after `startPos`.
 * Returns the parsed tag or null if no more tags.
 */
function findTag(input: string, startPos: number): ParsedTag | null {
  const openIdx = input.indexOf("<", startPos);
  if (openIdx < 0) return null;

  // Skip closing tags </...>
  if (input[openIdx + 1] === "/") {
    const closeIdx = input.indexOf(">", openIdx);
    if (closeIdx < 0) return null;
    return {
      name: "",
      attrs: [],
      content: "",
      selfClosing: false,
      end: closeIdx + 1,
    };
  }

  // Find end of opening tag
  let tagEnd = openIdx + 1;
  let inQuote = false;
  let quoteChar = "";
  let selfClosing = false;

  while (tagEnd < input.length) {
    const ch = input[tagEnd];
    if (inQuote) {
      if (ch === quoteChar) inQuote = false;
    } else {
      if (ch === '"' || ch === "'") {
        inQuote = true;
        quoteChar = ch;
      } else if (ch === ">") {
        break;
      } else if (ch === "/" && tagEnd + 1 < input.length && input[tagEnd + 1] === ">") {
        selfClosing = true;
        tagEnd++; // skip past '/'
        break;
      }
    }
    tagEnd++;
  }

  if (tagEnd >= input.length) return null;

  const tagStr = input.slice(openIdx + 1, tagEnd);
  const closeIdx = tagEnd + 1; // position after '>'

  // Parse tag name
  const nameMatch = tagStr.match(/^(\S+)/);
  if (!nameMatch) return null;
  const tagName: string = nameMatch[1] ?? "unknown";

  // Parse attributes
  const attrs = parseAttrs(tagStr);

  if (selfClosing) {
    return {
      name: tagName,
      attrs,
      content: "",
      selfClosing: true,
      end: closeIdx,
    };
  }

  // Find closing tag: </tagName>
  let searchFrom = closeIdx;
  let depth = 1;

  while (searchFrom < input.length) {
    const nextOpen = input.indexOf("<", searchFrom);
    if (nextOpen < 0) break;

    // Check self-closing
    const slashNext = nextOpen + 1;
    if (slashNext < input.length && input[slashNext] === "/" ) {
      // Closing tag
      const endTagEnd = input.indexOf(">", nextOpen);
      if (endTagEnd < 0) break;
      const closeTagName = input.slice(nextOpen + 2, endTagEnd).trim().split(/\s/)[0];
      if (closeTagName === tagName) {
        depth--;
        if (depth === 0) {
          const content = input.slice(closeIdx, nextOpen);
          return {
            name: tagName,
            attrs,
            content,
            selfClosing: false,
            end: endTagEnd + 1,
          };
        }
      }
      searchFrom = endTagEnd + 1;
    } else {
      // Check if this is an opening tag (same name → nesting)
      const tagNameMatch = input.slice(nextOpen + 1).match(/^(\w+)/);
      if (tagNameMatch && tagNameMatch[1] === tagName) {
        depth++;
      }
      // Skip to end of this tag
      const tagClose = findTagEnd(input, nextOpen);
      if (tagClose < 0) break;
      searchFrom = tagClose;
    }
  }

  // No proper closing found — return content to end
  return {
    name: tagName,
    attrs,
    content: input.slice(closeIdx),
    selfClosing: false,
    end: input.length,
  };
}

/**
 * Find the end of an XML tag starting at `startIdx`.
 */
function findTagEnd(input: string, startIdx: number): number {
  let i = startIdx + 1;
  let inQuote = false;
  let quoteChar = "";
  while (i < input.length) {
    const ch = input[i];
    if (inQuote) {
      if (ch === quoteChar) inQuote = false;
    } else {
      if (ch === '"' || ch === "'") {
        inQuote = true;
        quoteChar = ch;
      } else if (ch === ">") {
        return i + 1;
      }
    }
    i++;
  }
  return -1;
}

/**
 * Parse attributes from an XML tag string (excluding the tag name).
 * Handles: name="value", name='value'
 */
function parseAttrs(tagStr: string): ParsedAttr[] {
  const attrs: ParsedAttr[] = [];

  // Remove tag name from the start
  const afterName = tagStr.replace(/^\S+\s*/, "");

  // Match name="value" or name='value'
  const attrRegex = /(\S+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(afterName)) !== null) {
    attrs.push({
      name: match[1] ?? "",
      value: match[2] ?? match[3] ?? "",
    });
  }

  return attrs;
}

/**
 * Get attribute value by name (case-sensitive).
 */
function getAttr(attrs: ParsedAttr[], name: string): string | undefined {
  return attrs.find(a => a.name === name)?.value;
}

/**
 * Extract error message from a <failure> or <error> element's content or
 * message attribute.
 */
function extractErrorMessage(content: string): string | undefined {
  // Try <failure message="..."> first
  const failureAttrMsg = content.match(/<failure[\s>][^>]*?message\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  if (failureAttrMsg) {
    const msg = (failureAttrMsg[1] ?? failureAttrMsg[2]);
    if (msg && msg.length > 0) return decodeXmlEntities(msg);
  }

  // Try <error message="...">
  const errorAttrMsg = content.match(/<error[\s>][^>]*?message\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  if (errorAttrMsg) {
    const msg = (errorAttrMsg[1] ?? errorAttrMsg[2]);
    if (msg && msg.length > 0) return decodeXmlEntities(msg);
  }

  // Fallback: extract text between <failure>... or <failure ...> and </failure>
  // Use tag-aware scanning instead of regex to handle > in text content
  const failText = extractTagBody(content, "failure");
  if (failText !== undefined) return failText;

  // Try <error>text content</error>
  const errText = extractTagBody(content, "error");
  if (errText !== undefined) return errText;

  return undefined;
}

/**
 * Extract text body from an XML element by scanning tag boundaries.
 * Handles > characters in text content properly.
 */
function extractTagBody(content: string, tagName: string): string | undefined {
  const openTagRegex = new RegExp(`<${tagName}([\\s>])`, "i");
  const openMatch = openTagRegex.exec(content);
  if (!openMatch) return undefined;

  const openStart = openMatch.index;
  // Find the closing > of the opening tag (handle quotes)
  let searchPos = openStart + tagName.length + 1; // past "<tagName"
  let inQ = false;
  let qChar = "";
  while (searchPos < content.length) {
    const ch = content[searchPos];
    if (inQ) {
      if (ch === qChar) inQ = false;
    } else {
      if (ch === '"' || ch === "'") {
        inQ = true;
        qChar = ch;
      } else if (ch === ">") {
        break; // found end of opening tag
      }
    }
    searchPos++;
  }
  if (searchPos >= content.length) return undefined;

  const bodyStart = searchPos + 1; // after '>'
  // Find </tagName>
  const closeTag = `</${tagName}>`;
  const closeIdx = content.indexOf(closeTag, bodyStart);
  if (closeIdx < 0) return undefined;

  const body = content.slice(bodyStart, closeIdx).trim();
  if (body.length === 0) return undefined;
  return decodeXmlEntities(body.slice(0, 200));
}

/**
 * Decode XML entities in a string.
 * Handles &amp; &lt; &gt; &quot; &apos; and numeric entities &#xxx;
 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code) => String.fromCodePoint(parseInt(code, 16)));
}
