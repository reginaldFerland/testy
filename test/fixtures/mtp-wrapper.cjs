// A collector stand-in: starts slowly (TESTY_WRAPPER_DELAY ms), then runs the wrapped command.
const {spawn}=require('node:child_process');
setTimeout(()=>{
 const child=spawn(process.argv[2],process.argv.slice(3),{stdio:'inherit'});
 child.once('exit',code=>process.exit(code??1));
},Number(process.env.TESTY_WRAPPER_DELAY||0));
