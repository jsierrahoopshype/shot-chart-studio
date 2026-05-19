\# Shot Chart Studio



An analytics tool for \[HoopsMatic](https://hoopsmatic.com) that lets users build and compare NBA player shot charts from the 1996/97 season through the present.



Powered by data from the public \[`cdechoch/nba-data-archive`](https://huggingface.co/datasets/cdechoch/nba-data-archive) dataset on HuggingFace.



\*\*Status:\*\* work in progress. The catalog generator (`scripts/build\_player\_catalog.py`) and the resulting `data/players.json` are the only components in place so far. A UI for building shot charts will follow.



\## Quick start



&#x20;   pip install -r requirements.txt

&#x20;   python scripts/build\_player\_catalog.py



This produces `data/players.json`, a per-player index keyed by `PLAYER\_ID` with canonical name, distinct seasons, first/last season, and total shot count.



\## License



MIT. See \[LICENSE](LICENSE).

