/**
 * Table test for docs/knowledgebase/algorithms/workhub-terminal-replay.md: each row of
 * docs/algorithm-examples/workhub-terminal-replay.json runs `replaySegments` and compares the
 * segments exactly.
 *
 * The rows file is imported as JSON (the web package has no Node types for the shared CommonJS
 * loader); `parseRows` checks the row shape the loader would check.
 */
import { expect, it } from "vitest";

import rowsJson from "../../../../docs/algorithm-examples/workhub-terminal-replay.json";
import { replaySegments, type ReplaySegment } from "./replay";

interface Size {
  cols: number;
  rows: number;
}

interface ReplayRow {
  id: string;
  input: {
    totalBytes: number;
    initial: Size;
    resizes: { offset: number; cols: number; rows: number }[];
  };
  expected: { segments: ReplaySegment[] };
  note: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSize(v: unknown): v is Size {
  return (
    isObject(v) && typeof v.cols === "number" && typeof v.rows === "number"
  );
}

function isResize(
  v: unknown,
): v is { offset: number; cols: number; rows: number } {
  return isSize(v) && isObject(v) && typeof v.offset === "number";
}

function isSegment(v: unknown): v is ReplaySegment {
  return (
    isSize(v) &&
    isObject(v) &&
    typeof v.start === "number" &&
    typeof v.end === "number"
  );
}

function parseRows(data: unknown): ReplayRow[] {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("workhub-terminal-replay.json: expected a non-empty array");
  }
  const seen = new Set<string>();
  return data.map((row: unknown, i): ReplayRow => {
    if (!isObject(row) || typeof row.id !== "string" || row.id === "") {
      throw new Error(`row ${i}: missing id`);
    }
    const { id, input, expected, note } = row;
    if (seen.has(id)) throw new Error(`${id}: duplicate id`);
    seen.add(id);
    if (typeof note !== "string" || note.trim() === "")
      throw new Error(`${id}: missing note`);
    if (
      !isObject(input) ||
      typeof input.totalBytes !== "number" ||
      !isSize(input.initial) ||
      !Array.isArray(input.resizes) ||
      !input.resizes.every(isResize)
    ) {
      throw new Error(`${id}: malformed input`);
    }
    if (
      !isObject(expected) ||
      !Array.isArray(expected.segments) ||
      !expected.segments.every(isSegment)
    ) {
      throw new Error(`${id}: malformed expected`);
    }
    return {
      id,
      input: {
        totalBytes: input.totalBytes,
        initial: input.initial,
        resizes: input.resizes,
      },
      expected: { segments: expected.segments },
      note,
    };
  });
}

const rowsData: unknown = rowsJson;
const rows = parseRows(rowsData);

it.each(rows)("$id", ({ input, expected }) => {
  expect(
    replaySegments(input.totalBytes, input.initial, input.resizes),
  ).toEqual(expected.segments);
});
