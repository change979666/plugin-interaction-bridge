import openai
import threading
from .state import log_queue

class AIEngine:
    def __init__(self):
        self.api_key = ""
        self.base_url = "https://api.openai.com/v1"
        self.model = "gpt-3.5-turbo"
        self.prompt_template = ""

    def update_config(self, api_key, base_url, model, prompt_template):
        self.api_key = api_key
        self.base_url = base_url
        self.model = model
        self.prompt_template = prompt_template

    def test_connection(self, callback):
        def _run():
            try:
                client = openai.OpenAI(api_key=self.api_key, base_url=self.base_url)
                response = client.chat.completions.create(
                    model=self.model,
                    messages=[{"role": "user", "content": "Hello, reply 'OK' if you receive this."}],
                    max_tokens=10
                )
                reply = response.choices[0].message.content
                callback(True, reply)
            except Exception as e:
                callback(False, str(e))
        
        threading.Thread(target=_run, daemon=True).start()

    def generate_reply(self, title, comments, callback):
        def _run():
            try:
                # Prepare prompt
                c1 = comments[0]['content'] if len(comments) > 0 else "None"
                c2 = comments[1]['content'] if len(comments) > 1 else "None"
                c3 = comments[2]['content'] if len(comments) > 2 else "None"
                
                prompt = self.prompt_template.replace("{title}", title)\
                                           .replace("{comment_1}", c1)\
                                           .replace("{comment_2}", c2)\
                                           .replace("{comment_3}", c3)
                
                log_queue.put(f"🤖 AI 思考中... (Model: {self.model})")
                
                client = openai.OpenAI(api_key=self.api_key, base_url=self.base_url)
                response = client.chat.completions.create(
                    model=self.model,
                    messages=[{"role": "user", "content": prompt}],
                    max_tokens=150
                )
                
                result = response.choices[0].message.content.strip()
                callback(True, result)
                
            except Exception as e:
                callback(False, str(e))

        threading.Thread(target=_run, daemon=True).start()
