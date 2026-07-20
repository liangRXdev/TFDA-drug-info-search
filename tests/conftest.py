import sys
from pathlib import Path

# build_data.py 位於 repo 根目錄，非套件，需手動加入 import 路徑
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
