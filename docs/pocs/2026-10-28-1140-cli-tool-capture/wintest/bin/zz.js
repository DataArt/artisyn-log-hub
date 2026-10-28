for (let i=0;i<20000;i++) process.stdout.write(`zz line ${i} args=${process.argv.slice(2).join(" ")}
`);
if (process.argv[2]==="fail") { console.error("boom"); process.exitCode=3; }
