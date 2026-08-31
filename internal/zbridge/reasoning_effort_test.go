package zbridge

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestReasoningEffortForTurn(t *testing.T) {
	initial := []Message{{Role: "user", Content: json.RawMessage(`"inspect the project"`)}}
	afterTool := []Message{
		{Role: "user", Content: json.RawMessage(`"inspect the project"`)},
		{Role: "assistant", Content: json.RawMessage(`""`)},
		{Role: "tool", Content: json.RawMessage(`"file list"`)},
	}

	for _, tc := range []struct {
		name     string
		messages []Message
		effort   string
		deflt    string
		want     string
	}{
		// explicit client effort always wins, whatever the default
		{"initial low", initial, "low", "", "low"},
		{"initial high", initial, "high", "", "high"},
		{"initial max", initial, "max", "", "max"},
		{"tool low", afterTool, "low", "", "low"},
		{"tool high", afterTool, "high", "", "low"},
		{"tool max", afterTool, "max", "", "high"},
		// agent default applies only when the client sent no effort
		{"no effort, agent default", initial, "", "low", "low"},
		{"no effort, no default (plain chat)", initial, "", "", ""},
		{"no effort, default decays after tool", afterTool, "", "low", "low"},
		{"no effort, max default decays after tool", afterTool, "", "max", "high"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := reasoningEffortForTurn(tc.messages, tc.effort, tc.deflt); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestAnthropicPreservesReasoningEffort(t *testing.T) {
	converted, err := anthropicToOpenAIRequest([]byte(`{
		"model":"glm-5.2",
		"max_tokens":1024,
		"reasoning_effort":"low",
		"messages":[{"role":"user","content":"inspect"}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]interface{}
	if err := json.Unmarshal(converted, &got); err != nil {
		t.Fatal(err)
	}
	if got["reasoning_effort"] != "low" {
		t.Fatalf("reasoning_effort lost during conversion: %s", converted)
	}
}

func TestAgentPromptPrefersActionOverExhaustivePlanning(t *testing.T) {
	prompt := buildAgentPrompt(
		[]agentMessage{{Role: "user", Content: json.RawMessage(`"inspect the project"`)}},
		[]openAITool{{Name: "Read"}},
	)
	if !strings.Contains(prompt, "Think enough to choose the next useful action, then act") {
		t.Fatal("agent prompt lacks execution-oriented reasoning guidance")
	}
}
