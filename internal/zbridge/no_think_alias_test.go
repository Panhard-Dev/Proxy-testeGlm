package zbridge

import (
	"strings"
	"testing"
)

func TestResolveModelAlias(t *testing.T) {
	for _, tc := range []struct {
		in        string
		wantBase  string
		wantThink bool
	}{
		{"x-preview-l", "x-preview-l", false},
		{"x-preview-l-no-think", "x-preview-l", true},
		{"glm-5.3-no-think", "glm-5.3", true},
		{"GLM-5.3-NO-THINK", "GLM-5.3", true},
		{"glm-4.7", "glm-4.7", false},
		{"-no-think", "-no-think", false}, // bare suffix is not an alias
		{"", "", false},
	} {
		base, noThink := resolveModelAlias(tc.in)
		if base != tc.wantBase || noThink != tc.wantThink {
			t.Fatalf("resolveModelAlias(%q) = (%q, %v), want (%q, %v)",
				tc.in, base, noThink, tc.wantBase, tc.wantThink)
		}
	}
}

func TestNoThinkAliasPinsEffortLow(t *testing.T) {
	// The OpenAI handler resolves the alias before building opts; simulate
	// the same resolution the handlers do for a -no-think request.
	rawModel := "x-preview-l-no-think"
	model, noThink := resolveModelAlias(rawModel)
	if model != "x-preview-l" || !noThink {
		t.Fatalf("alias resolution: model=%q noThink=%v", model, noThink)
	}
	effort := reasoningEffortForTurn(nil, "", "")
	if noThink && (effort == "" || !isValidReasoningEffort(effort)) {
		effort = "low"
	}
	if effort != "low" {
		t.Fatalf("no-think effort = %q, want low", effort)
	}
}

func TestNoThinkAliasListsOnlyReasoningModels(t *testing.T) {
	capsReasoning := map[string]interface{}{"reasoning_effort": true}
	capsPlain := map[string]interface{}{"reasoning_effort": false}
	models := []ModelInfo{
		{ID: "x-preview-l", Capabilities: capsReasoning},
		{ID: "glm-4.7", Capabilities: capsPlain},
	}
	got := noThinkModels(models)
	if len(got) != 1 || got[0] != "x-preview-l" {
		t.Fatalf("noThinkModels = %v, want [x-preview-l]", got)
	}
	if !strings.HasSuffix(got[0]+noThinkSuffix, "-no-think") {
		t.Fatal("suffix mismatch")
	}
}
