#!/bin/bash
# Comparison test: Original MCP vs Agentic MCP
# Measures: tool calls, response size, latency

CANVAS_KEY="put your canvas api key here"
OPENROUTER_KEY="put your openrouter api key here"

ORIGINAL_URL="https://canvas-mcp.soyrun.workers.dev/mcp?canvasApiKey=${CANVAS_KEY}"
AGENTIC_URL="https://canvas-mcp-claude.soyrun.workers.dev/mcp?canvasApiKey=${CANVAS_KEY}&openRouterApiKey=${OPENROUTER_KEY}"

echo "=========================================="
echo "  MCP Server Comparison Test"
echo "  Original (v1) vs Agentic (v2)"
echo "=========================================="
echo ""

# --------------------------------------------------
# TEST 1: Finding assignments in a specific course
# --------------------------------------------------
echo "=== TEST 1: Find assignments in a course ==="
echo ""

# ORIGINAL: Requires multiple tool calls
echo "--- ORIGINAL VERSION (v1) ---"
echo "Step 1/3: get_courses"
T1_START=$(python3 -c "import time; print(time.time())")

COURSES=$(curl -s -X POST "${ORIGINAL_URL}" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_courses","arguments":{}}}')

T1_COURSES=$(python3 -c "import time; print(time.time())")
COURSES_SIZE=$(echo "$COURSES" | wc -c | tr -d ' ')
echo "  Response size: ${COURSES_SIZE} bytes"
echo "  Time: $(python3 -c "print(f'{$T1_COURSES - $T1_START:.2f}s')")"

# Extract a course ID with "APM" or "MAT" in name
COURSE_ID=$(echo "$COURSES" | python3 -c "
import sys, json
data = json.load(sys.stdin)
text = data.get('result',{}).get('content',[{}])[0].get('text','')
courses = json.loads(text)
for name, cid in courses.items():
    if 'APM' in name or 'MAT' in name or 'CSE' in name:
        print(cid)
        break
" 2>/dev/null)

echo "  Found course ID: ${COURSE_ID}"

echo "Step 2/3: get_course_assignments(${COURSE_ID})"
ASSIGNMENTS=$(curl -s -X POST "${ORIGINAL_URL}" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"get_course_assignments\",\"arguments\":{\"course_id\":\"${COURSE_ID}\"}}}")

T1_END=$(python3 -c "import time; print(time.time())")
ASSIGNMENTS_SIZE=$(echo "$ASSIGNMENTS" | wc -c | tr -d ' ')
echo "  Response size: ${ASSIGNMENTS_SIZE} bytes"
echo "  Time: $(python3 -c "print(f'{$T1_END - $T1_COURSES:.2f}s')")"

TOTAL_ORIGINAL_1=$(python3 -c "print(f'{$T1_END - $T1_START:.2f}')")
TOTAL_BYTES_ORIGINAL_1=$((COURSES_SIZE + ASSIGNMENTS_SIZE))

echo ""
echo "ORIGINAL TOTALS:"
echo "  Tool calls: 2"
echo "  Total bytes transferred: ${TOTAL_BYTES_ORIGINAL_1}"
echo "  Total time: ${TOTAL_ORIGINAL_1}s"
echo ""

# AGENTIC: Single tool call
echo "--- AGENTIC VERSION (v2) ---"
echo "Step 1/1: find_assignments"
T2_START=$(python3 -c "import time; print(time.time())")

AGENTIC_RESULT=$(curl -s -X POST "${AGENTIC_URL}" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"find_assignments","arguments":{"query":"Find all assignments for any math or APM course"}}}' \
  --max-time 120)

T2_END=$(python3 -c "import time; print(time.time())")
AGENTIC_SIZE=$(echo "$AGENTIC_RESULT" | wc -c | tr -d ' ')

echo "  Response size: ${AGENTIC_SIZE} bytes"
echo "  Time: $(python3 -c "print(f'{$T2_END - $T2_START:.2f}s')")"
echo ""
echo "AGENTIC TOTALS:"
echo "  Tool calls: 1"
echo "  Total bytes transferred: ${AGENTIC_SIZE}"
echo "  Total time: $(python3 -c "print(f'{$T2_END - $T2_START:.2f}s')")"
echo ""

# Print agentic response content
echo "--- Agentic Response Content ---"
echo "$AGENTIC_RESULT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    text = data.get('result',{}).get('content',[{}])[0].get('text','')
    print(text[:2000])
except Exception as e:
    print(f'Parse error: {e}')
    print(sys.stdin.read()[:500])
" 2>&1
echo ""

# --------------------------------------------------
# TEST 2: Finding resources (deep hierarchy traversal)
# --------------------------------------------------
echo "=========================================="
echo "=== TEST 2: Find resources in a course ==="
echo "=========================================="
echo ""

# ORIGINAL: Requires 3+ tool calls (courses -> modules -> module_items)
echo "--- ORIGINAL VERSION (v1) ---"
T3_START=$(python3 -c "import time; print(time.time())")

echo "Step 1/4: get_courses"
# Already have courses from above, but count it
COURSES2=$(curl -s -X POST "${ORIGINAL_URL}" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"get_courses","arguments":{}}}')
C2_SIZE=$(echo "$COURSES2" | wc -c | tr -d ' ')

T3_AFTER_COURSES=$(python3 -c "import time; print(time.time())")
echo "  Time: $(python3 -c "print(f'{$T3_AFTER_COURSES - $T3_START:.2f}s')"), Size: ${C2_SIZE} bytes"

echo "Step 2/4: get_modules(${COURSE_ID})"
MODULES=$(curl -s -X POST "${ORIGINAL_URL}" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"tools/call\",\"params\":{\"name\":\"get_modules\",\"arguments\":{\"course_id\":\"${COURSE_ID}\"}}}")
M_SIZE=$(echo "$MODULES" | wc -c | tr -d ' ')

T3_AFTER_MODULES=$(python3 -c "import time; print(time.time())")
echo "  Time: $(python3 -c "print(f'{$T3_AFTER_MODULES - $T3_AFTER_COURSES:.2f}s')"), Size: ${M_SIZE} bytes"

# Get first module ID
MODULE_ID=$(echo "$MODULES" | python3 -c "
import sys, json
data = json.load(sys.stdin)
text = data.get('result',{}).get('content',[{}])[0].get('text','')
modules = json.loads(text)
if modules and len(modules) > 0:
    print(modules[0]['id'])
" 2>/dev/null)

echo "Step 3/4: get_module_items(${COURSE_ID}, ${MODULE_ID})"
ITEMS=$(curl -s -X POST "${ORIGINAL_URL}" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":12,\"method\":\"tools/call\",\"params\":{\"name\":\"get_module_items\",\"arguments\":{\"course_id\":\"${COURSE_ID}\",\"module_id\":\"${MODULE_ID}\"}}}")
I_SIZE=$(echo "$ITEMS" | wc -c | tr -d ' ')

T3_END=$(python3 -c "import time; print(time.time())")
echo "  Time: $(python3 -c "print(f'{$T3_END - $T3_AFTER_MODULES:.2f}s')"), Size: ${I_SIZE} bytes"

TOTAL_ORIGINAL_2=$((C2_SIZE + M_SIZE + I_SIZE))
echo ""
echo "ORIGINAL TOTALS:"
echo "  Tool calls: 3 (minimum - a real client may need more to search multiple modules)"
echo "  Total bytes transferred: ${TOTAL_ORIGINAL_2}"
echo "  Total time: $(python3 -c "print(f'{$T3_END - $T3_START:.2f}s')")"
echo ""

# AGENTIC: Single tool call
echo "--- AGENTIC VERSION (v2) ---"
echo "Step 1/1: find_resources"
T4_START=$(python3 -c "import time; print(time.time())")

AGENTIC_RESULT2=$(curl -s -X POST "${AGENTIC_URL}" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"find_resources","arguments":{"query":"Find all files and resources in any APM or math course"}}}' \
  --max-time 120)

T4_END=$(python3 -c "import time; print(time.time())")
AGENTIC2_SIZE=$(echo "$AGENTIC_RESULT2" | wc -c | tr -d ' ')

echo "  Time: $(python3 -c "print(f'{$T4_END - $T4_START:.2f}s')")"
echo "  Response size: ${AGENTIC2_SIZE} bytes"
echo ""
echo "AGENTIC TOTALS:"
echo "  Tool calls: 1"
echo "  Total bytes transferred: ${AGENTIC2_SIZE}"
echo "  Total time: $(python3 -c "print(f'{$T4_END - $T4_START:.2f}s')")"
echo ""

echo "--- Agentic Response Content ---"
echo "$AGENTIC_RESULT2" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    text = data.get('result',{}).get('content',[{}])[0].get('text','')
    print(text[:3000])
except Exception as e:
    print(f'Parse error: {e}')
" 2>&1

echo ""
echo "=========================================="
echo "  COMPARISON SUMMARY"
echo "=========================================="
echo ""
echo "Test 1 (Find Assignments):"
echo "  Original: 2 tool calls, ${TOTAL_BYTES_ORIGINAL_1} bytes, ${TOTAL_ORIGINAL_1}s"
echo "  Agentic:  1 tool call,  ${AGENTIC_SIZE} bytes"
echo ""
echo "Test 2 (Find Resources - hierarchy traversal):"
echo "  Original: 3+ tool calls, ${TOTAL_ORIGINAL_2} bytes"
echo "  Agentic:  1 tool call,   ${AGENTIC2_SIZE} bytes"
echo ""
echo "Key insight: The original requires the CLIENT to make multiple"
echo "sequential tool calls and process intermediate results. The agentic"
echo "version handles all traversal internally, returning only final results."
