#!/usr/bin/env python3
"""
Benchmark: Original MCP (multi-tool) vs Agentic MCP (agent-in-disguise)

Runs 3 tests against both deployed servers, measures tool calls, latency,
and response size, then writes results to blog/data/ CSVs.
"""

import json
import time
import csv
import os
import sys
import requests

CANVAS_KEY = "7236%7EYk9FwCv7K6UGGYTFeD2ANKk47MawfYrKt4wQKVUCm6zzExFWDey7mCePAcQuey9Y"
OPENROUTER_KEY = "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"

ORIGINAL_URL = f"https://canvas-mcp.soyrun.workers.dev/mcp?canvasApiKey={CANVAS_KEY}"
AGENTIC_URL = f"https://canvas-mcp-claude.soyrun.workers.dev/mcp?canvasApiKey={CANVAS_KEY}&openRouterApiKey={OPENROUTER_KEY}"


def mcp_call(url, method_name, arguments, timeout=120):
    """Make a single MCP tool call, return (response_json, bytes, elapsed_s)."""
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": method_name, "arguments": arguments},
    }
    start = time.time()
    resp = requests.post(
        url,
        json=payload,
        headers={"Content-Type": "application/json"},
        timeout=timeout,
    )
    elapsed = time.time() - start
    raw = resp.content
    data = resp.json()
    return data, len(raw), elapsed


def extract_text(data):
    """Pull the text content from an MCP response."""
    try:
        return data["result"]["content"][0]["text"]
    except (KeyError, IndexError, TypeError):
        return ""


def parse_courses(text):
    """Parse course name->id map from get_courses response."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {}


def parse_modules(text):
    """Parse module list from get_modules response."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return []


# ─────────────────────────────────────────────
# TEST 1: Find assignments for math courses
# ─────────────────────────────────────────────

def test1_original():
    """Original: get_courses, identify math courses, get_assignments for each."""
    print("  [original] get_courses...")
    courses_data, courses_bytes, courses_time = mcp_call(ORIGINAL_URL, "get_courses", {})
    courses = parse_courses(extract_text(courses_data))
    tool_calls = 1
    total_bytes = courses_bytes
    total_time = courses_time

    math_courses = {
        name: cid for name, cid in courses.items()
        if any(kw in name.upper() for kw in ["APM", "MAT", "MATH", "CALCULUS"])
    }
    print(f"  [original] found {len(math_courses)} math courses, fetching assignments...")

    for name, cid in math_courses.items():
        data, nbytes, elapsed = mcp_call(ORIGINAL_URL, "get_course_assignments", {"course_id": str(cid)})
        tool_calls += 1
        total_bytes += nbytes
        total_time += elapsed

    return {
        "tool_calls": tool_calls,
        "bytes": total_bytes,
        "latency_s": round(total_time, 2),
    }


def test1_agentic():
    """Agentic: single find_assignments call."""
    print("  [agentic] find_assignments...")
    data, nbytes, elapsed = mcp_call(
        AGENTIC_URL, "find_assignments",
        {"query": "Find all assignments for any math or APM course"},
    )
    return {
        "tool_calls": 1,
        "bytes": nbytes,
        "latency_s": round(elapsed, 2),
    }


# ─────────────────────────────────────────────
# TEST 2: Upcoming assignments across ALL courses
# ─────────────────────────────────────────────

def test2_original():
    """Original: get_courses, then get_course_assignments for EVERY course."""
    print("  [original] get_courses...")
    courses_data, courses_bytes, courses_time = mcp_call(ORIGINAL_URL, "get_courses", {})
    courses = parse_courses(extract_text(courses_data))
    tool_calls = 1
    total_bytes = courses_bytes
    total_time = courses_time

    print(f"  [original] fetching assignments for all {len(courses)} courses...")
    for i, (name, cid) in enumerate(courses.items()):
        data, nbytes, elapsed = mcp_call(ORIGINAL_URL, "get_course_assignments", {"course_id": str(cid)})
        tool_calls += 1
        total_bytes += nbytes
        total_time += elapsed
        if (i + 1) % 10 == 0:
            print(f"    ...{i + 1}/{len(courses)} done")

    return {
        "tool_calls": tool_calls,
        "bytes": total_bytes,
        "latency_s": round(total_time, 2),
    }


def test2_agentic():
    """Agentic: single find_assignments call."""
    print("  [agentic] find_assignments...")
    data, nbytes, elapsed = mcp_call(
        AGENTIC_URL, "find_assignments",
        {"query": "What are all my upcoming assignments due in the next 2 weeks?"},
    )
    return {
        "tool_calls": 1,
        "bytes": nbytes,
        "latency_s": round(elapsed, 2),
    }


# ─────────────────────────────────────────────
# TEST 3: Course overview (CSE 450)
# ─────────────────────────────────────────────

def test3_original():
    """Original: get_courses, get_modules, get_module_items for each module, get_assignments."""
    print("  [original] get_courses...")
    courses_data, courses_bytes, courses_time = mcp_call(ORIGINAL_URL, "get_courses", {})
    courses = parse_courses(extract_text(courses_data))
    tool_calls = 1
    total_bytes = courses_bytes
    total_time = courses_time

    cse_course_id = None
    for name, cid in courses.items():
        if "CSE 450" in name or "CSE450" in name:
            cse_course_id = str(cid)
            break

    if not cse_course_id:
        for name, cid in courses.items():
            if "450" in name:
                cse_course_id = str(cid)
                break

    if not cse_course_id:
        print("  [original] WARNING: CSE 450 not found, using first course")
        cse_course_id = str(list(courses.values())[0])

    print(f"  [original] get_modules({cse_course_id})...")
    modules_data, modules_bytes, modules_time = mcp_call(ORIGINAL_URL, "get_modules", {"course_id": cse_course_id})
    modules = parse_modules(extract_text(modules_data))
    tool_calls += 1
    total_bytes += modules_bytes
    total_time += modules_time

    print(f"  [original] get_module_items for {len(modules)} modules...")
    for mod in modules:
        data, nbytes, elapsed = mcp_call(
            ORIGINAL_URL, "get_module_items",
            {"course_id": cse_course_id, "module_id": str(mod["id"])},
        )
        tool_calls += 1
        total_bytes += nbytes
        total_time += elapsed

    print("  [original] get_course_assignments...")
    data, nbytes, elapsed = mcp_call(ORIGINAL_URL, "get_course_assignments", {"course_id": cse_course_id})
    tool_calls += 1
    total_bytes += nbytes
    total_time += elapsed

    return {
        "tool_calls": tool_calls,
        "bytes": total_bytes,
        "latency_s": round(total_time, 2),
    }


def test3_agentic():
    """Agentic: single course_overview call."""
    print("  [agentic] course_overview...")
    data, nbytes, elapsed = mcp_call(
        AGENTIC_URL, "course_overview",
        {"query": "Give me a comprehensive overview of CSE 450"},
    )
    return {
        "tool_calls": 1,
        "bytes": nbytes,
        "latency_s": round(elapsed, 2),
    }


# ─────────────────────────────────────────────
# Run all tests and write CSVs
# ─────────────────────────────────────────────

def write_csvs(results):
    data_dir = os.path.join(os.path.dirname(__file__), "data")
    os.makedirs(data_dir, exist_ok=True)

    with open(os.path.join(data_dir, "tool-calls.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["query", "original", "agentic"])
        for r in results:
            w.writerow([r["query"], r["original"]["tool_calls"], r["agentic"]["tool_calls"]])

    with open(os.path.join(data_dir, "latency.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["query", "original_s", "agentic_s"])
        for r in results:
            w.writerow([r["query"], r["original"]["latency_s"], r["agentic"]["latency_s"]])

    with open(os.path.join(data_dir, "response-size.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["query", "original_bytes", "agentic_bytes"])
        for r in results:
            w.writerow([r["query"], r["original"]["bytes"], r["agentic"]["bytes"]])

    print(f"\nCSVs written to {data_dir}/")


def main():
    results = []

    tests = [
        ("Find math course assignments", test1_original, test1_agentic),
        ("Upcoming assignments (all courses)", test2_original, test2_agentic),
        ("Course overview (CSE 450)", test3_original, test3_agentic),
    ]

    for query, orig_fn, agent_fn in tests:
        print(f"\n{'=' * 50}")
        print(f"TEST: {query}")
        print('=' * 50)

        print("\nRunning original...")
        orig = orig_fn()
        print(f"  => {orig}")

        print("\nRunning agentic...")
        agent = agent_fn()
        print(f"  => {agent}")

        results.append({"query": query, "original": orig, "agentic": agent})

    print(f"\n{'=' * 50}")
    print("SUMMARY")
    print('=' * 50)
    for r in results:
        o, a = r["original"], r["agentic"]
        print(f"\n{r['query']}:")
        print(f"  Tool calls:  {o['tool_calls']:>4} → {a['tool_calls']:>4}  ({100 * (1 - a['tool_calls'] / o['tool_calls']):.1f}% reduction)")
        print(f"  Latency:     {o['latency_s']:>7.2f}s → {a['latency_s']:>7.2f}s")
        print(f"  Bytes:       {o['bytes']:>8} → {a['bytes']:>8}  ({100 * (1 - a['bytes'] / o['bytes']):.1f}% reduction)")

    write_csvs(results)


if __name__ == "__main__":
    main()
