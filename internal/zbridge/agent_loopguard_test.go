package zbridge

import (
    "encoding/json"
    "strings"
    "testing"
)

func loopGuardMessages(exchanges int) []agentMessage {
    msgs := []agentMessage{{Role: "user", Content: json.RawMessage(`"make it look nicer"`)}}
    for i := 0; i < exchanges; i++ {
        var tc assistantToolCall
        tc.Function.Name = "Edit"
        tc.Function.Arguments = json.RawMessage(`{"file_path":"x"}`)
        msgs = append(msgs,
            agentMessage{Role: "assistant", Content: json.RawMessage("null"), ToolCalls: []assistantToolCall{tc}},
            agentMessage{Role: "tool", Content: json.RawMessage(`"ok"`)},
        )
    }
    return msgs
}

// The prompt must anchor the next decision on the last tool result, not on
// the original request: <current_task> before <recent>, <current_step>
// between </recent> and <output_rules>. Ending with the original task is
// what looped open-ended sessions into endless edits.
func TestCurrentStepAnchorOrder(t *testing.T) {
    p := buildAgentPrompt(loopGuardMessages(3), nil)
    ti, ri, si, oi := strings.Index(p, "<current_task>"), strings.Index(p, "<recent>"),
        strings.Index(p, "<current_step>"), strings.Index(p, "<output_rules>")
    if ti < 0 || ri < 0 || si < 0 || oi < 0 {
        t.Fatalf("missing section: task=%d recent=%d step=%d rules=%d", ti, ri, si, oi)
    }
    if !(ti < ri && ri < si && si < oi) {
        t.Fatalf("wrong section order: task=%d recent=%d step=%d rules=%d", ti, ri, si, oi)
    }
    if strings.Contains(p, "LOOP GUARD") {
        t.Fatal("loop guard fired below threshold")
    }
}

func TestLoopGuardFiresAtThreshold(t *testing.T) {
    p := buildAgentPrompt(loopGuardMessages(agentLoopGuardExchanges), nil)
    if !strings.Contains(p, "LOOP GUARD") {
        t.Fatal("loop guard did not fire at threshold")
    }
}

// A fresh request with no tool history must not carry a <current_step>
// section: the plain <current_task> anchor is the right one.
func TestNoCurrentStepWithoutToolHistory(t *testing.T) {
    p := buildAgentPrompt(loopGuardMessages(0), nil)
    if strings.Contains(p, "<current_step>") {
        t.Fatal("current_step rendered without tool history")
    }
}
