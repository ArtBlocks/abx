fetch("/api/seed").then(r => r.text()).then(value => { abx.traits({network: value}); abx.done(); });
