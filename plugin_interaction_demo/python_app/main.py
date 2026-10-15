import tkinter as tk
from python_app.ui import SmartCommentApp
from python_app.server import start_server_thread

def main():
    # Start HTTP Server
    start_server_thread()
    
    # Start UI
    root = tk.Tk()
    app = SmartCommentApp(root)
    try:
        root.mainloop()
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    main()
