// Labels for a posting's conditions (src/reqs.ts), used by the CSV export. The job list's filters
// and counts live in the UI and stay there.
package app

var TypeLabel = map[string]string{"fulltime": "全职", "parttime": "兼职", "internship": "实习", "contract": "合同工", "unknown": "没写"}
var DegreeLabel = map[string]string{"none": "不限学历", "diploma": "大专", "bachelor": "本科", "master": "硕士", "phd": "博士"}
var MaterialLabel = map[string]string{"cover_letter": "求职信", "transcript": "成绩单", "portfolio": "作品集", "references": "推荐人", "other": "其他材料"}
var AuthLabel = map[string]string{"citizen": "仅限公民", "citizen_pr": "仅限公民/PR"}

// typeLabel: "兼职实习 3 个月", "全职", "".
func typeLabel(f *JobFacts) string {
	months := ""
	if f.Months != nil && *f.Months != 0 {
		months = " " + numStr(*f.Months) + " 个月"
	}
	switch f.Type {
	case "internship":
		h := ""
		if f.Hours == "part" {
			h = "兼职"
		} else if f.Hours == "full" {
			h = "全职"
		}
		return h + "实习" + months
	case "contract":
		return "合同工" + months
	case "unknown":
		return ""
	}
	return TypeLabel[f.Type]
}

func yearsLabel(n float64) string {
	if n == 0 {
		return "不要经验"
	}
	return numStr(n) + " 年以上经验"
}
