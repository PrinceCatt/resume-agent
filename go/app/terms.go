// Catches model text that credits the candidate with a tool or skill the profile never mentions
// (the first real run's fit and interview prep both claimed ROS experience that is not there).
package app

import (
	"regexp"
	"strings"
)

// knownTerms are distinctive technical names; generic words (testing, embedded, spring, go) are left out on purpose.
var knownTerms = []string{
	"Python", "Java", "C++", "C#", "JavaScript", "TypeScript", "Golang", "Rust", "Kotlin", "Swift", "Scala", "PHP", "Ruby",
	"SQL", "MySQL", "PostgreSQL", "SQLite", "Redis", "MongoDB", "Elasticsearch", "Cassandra", "DynamoDB",
	"Spring Boot", "Django", "Flask", "FastAPI", "React", "Vue", "Angular", "Next.js", "Node.js", "Express", "Svelte",
	"Docker", "Kubernetes", "AWS", "GCP", "Azure", "Linux", "Git", "GitHub Actions", "Jenkins", "CI/CD", "Terraform", "Nginx",
	"Kafka", "RabbitMQ", "Spark", "Hadoop", "Airflow", "Flink",
	"PyTorch", "TensorFlow", "scikit-learn", "Pandas", "NumPy", "OpenCV", "LangChain", "LLM", "NLP", "RAG", "CUDA",
	"ROS", "ARM", "FPGA", "Verilog", "VHDL", "MATLAB", "Simulink", "RTOS", "STM32",
	"JUnit", "pytest", "Jest", "Selenium", "Playwright", "Cypress", "GraphQL", "gRPC", "REST API",
	"Unity", "Unreal", "Figma", "Tableau", "Power BI", "Agile", "Scrum", "Jira",
}

// termAliases are other ways a profile may write the same thing (the first real profile says "Robot Operating System").
var termAliases = map[string][]string{
	"ROS":          {"Robot Operating System"},
	"Kubernetes":   {"k8s"},
	"PostgreSQL":   {"Postgres"},
	"Node.js":      {"NodeJS"},
	"Next.js":      {"NextJS"},
	"JavaScript":   {"JS", "ECMAScript"},
	"TypeScript":   {"TS"},
	"Golang":       {"Go"},
	"scikit-learn": {"sklearn"},
	"Spring Boot":  {"SpringBoot"},
	"Power BI":     {"PowerBI"},
	"REST API":     {"RESTful", "REST"},
	"AWS":          {"Amazon Web Services"},
	"GCP":          {"Google Cloud"},
	"LLM":          {"large language model"},
	"NLP":          {"natural language processing"},
	"RAG":          {"retrieval-augmented", "retrieval augmented"},
}

// termHas reports whether the term appears as a word of its own (so "Java" is not found in "JavaScript").
// withVersion also accepts a version right after it, so a profile's "Vue3" or "HTML5" counts.
// The TS pattern ends in a lookahead (?![A-Za-z0-9+#]); RE2 has none, so it consumes one character or the end instead.
func termHas(text, term string, caseSensitive, withVersion bool) bool {
	version := ""
	if withVersion {
		version = `(?:[ -]?v?\d+(?:\.\d+)*)?`
	}
	flags := "i"
	if caseSensitive {
		flags = ""
	}
	return jsReCached(`(?:^|[^A-Za-z0-9+#])`+regexp.QuoteMeta(term)+version+`(?:[^A-Za-z0-9+#]|$)`, flags).MatchString(text)
}

// mentions reports whether the text names the term, under its own name or an alias (short aliases only in
// their own case), maybe with a version.
func mentions(text, term string) bool {
	if termHas(text, term, false, true) {
		return true
	}
	for _, name := range termAliases[term] {
		if termHas(text, name, u16len(name) <= 3, true) {
			return true
		}
	}
	return false
}

// profileText is everything the profile says, as one string to search.
func profileText(p Profile) string {
	parts := []string{p.Summary, p.ExtraFacts}
	for _, s := range p.Sections {
		parts = append(parts, s.Heading)
		for _, e := range s.Entries {
			parts = append(parts, e.Title, e.Subtitle, e.Location, e.Dates)
			for _, b := range e.Bullets {
				parts = append(parts, b.Text)
			}
		}
	}
	for _, g := range p.Skills {
		parts = append(parts, g.Label)
		parts = append(parts, g.Items...)
	}
	return strings.Join(parts, "\n")
}

var (
	reLooksTechnical = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9.+#/-]*( [A-Z][A-Za-z0-9.+#-]*)?$`)
	reHasUpper       = regexp.MustCompile(`[A-Z]`)
	reAcronym        = regexp.MustCompile(`^[A-Z0-9/+#]{2,5}$`)
)

// unsupportedTerms lists tool and skill names mentioned in `text` that the profile never mentions. Short
// all-caps names (ROS, ARM, AWS) only count when written in capitals, so "a robotic arm" is not ARM.
func unsupportedTerms(text, profile string, extra []string) []string {
	terms := append([]string{}, knownTerms...)
	for _, k := range extra {
		if reLooksTechnical.MatchString(k) && reHasUpper.MatchString(k) && u16len(k) >= 2 {
			terms = append(terms, k)
		}
	}
	out := []string{}
	for _, t := range uniq(terms) {
		acronym := reAcronym.MatchString(t)
		if !termHas(text, t, acronym, false) {
			continue
		}
		if !mentions(profile, t) {
			out = append(out, t)
		}
	}
	return out
}
