// Stand-in for the lody entry script in runner tests. The first argument picks
// a behavior (the runner strips custom env, so behavior cannot come from env).
const [mode, ...args] = process.argv.slice(2);

const readStdin = () =>
  new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (text += chunk));
    process.stdin.on('end', () => resolve(text));
  });

switch (mode) {
  case 'env': {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.startsWith('LODY_') || ['NO_COLOR', 'FORCE_COLOR', 'SECRET_THING'].includes(key))
    );
    console.log('info: some log line');
    console.log(JSON.stringify({ ok: true, args, env }));
    break;
  }
  case 'stdin': {
    const text = await readStdin();
    console.log(JSON.stringify({ ok: true, stdin: text }));
    break;
  }
  case 'stdin-ignored': {
    // With stdin set to 'ignore' the stream ends immediately instead of hanging.
    const text = await readStdin();
    console.log(JSON.stringify({ ok: true, stdinLength: text.length }));
    break;
  }
  case 'sleep':
    setTimeout(() => console.log(JSON.stringify({ ok: true })), Number(args[0] ?? 10_000));
    break;
  case 'ignore-sigterm':
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1_000);
    break;
  case 'flood':
    process.stdout.write('x'.repeat(Number(args[0] ?? 1_000_000)));
    break;
  case 'fail':
    console.error('error: something broke');
    console.log(JSON.stringify({ ok: false, error: 'Session not found: abc' }));
    process.exit(1);
    break;
  case 'lines': {
    for (const line of args) console.log(line);
    setInterval(() => {}, 1_000);
    break;
  }
  default:
    console.error(`unknown mode ${mode}`);
    process.exit(2);
}
