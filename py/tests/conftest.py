import os
import tempfile

# Keep the real data/ folder out of it: set before anything imports resume_agent.db.
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="resume-agent-test-")
os.environ.pop("RESUME_AGENT_HEADLESS_BROWSER", None)
