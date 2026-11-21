import { runTool, toolSettings } from './tools.js';

const englishCommand = /^(?:please )?(?:run|execute) (?:this |the |my )?python(?: (?:code|script))?(?: please)?$/i;
const hindiCommand = /^(?:कृपया )?(?:(?:यह|ये|इस|मेरा) )?(?:python|पायथन|पाइथन)(?: (?:कोड|स्क्रिप्ट))?(?: को)? (?:चलाओ|चलाएं|चलाएँ|चलाइए|चलाइये|चला दो|चला दें|रन करो|रन करें)$/i;
const usage = 'पहले “Python चलाओ” लिखें। अगली पंक्ति में ```python, फिर अपना कोड और आखिरी पंक्ति में ``` लिखें।';

// Called on the user's composer input. Restrict execution to a standalone
// command followed by exactly one fenced source block.
export function parseDirectPython(text) {
  if (typeof text !== 'string') return null;
  const lines = text.trim().replace(/\r\n?/g, '\n').split('\n');
  const command = lines.shift().trim().replace(/[.!:।]+$/, '').trim().replace(/[ \t]+/g, ' ');
  if (command !== '/python' && !englishCommand.test(command) && !hindiCommand.test(command)) return null;

  const first = lines.findIndex(line => line.trim());
  if (first < 0) return { error: usage };
  const opening = /^ {0,3}(`{3,}|~{3,})[ \t]*(?:python3?|py)?[ \t]*$/i.exec(lines[first]);
  if (!opening) return { error: usage };
  const fence = opening[1];
  const body = lines.slice(first + 1);
  const end = body.findIndex(line => {
    const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
    return closing && closing[1][0] === fence[0] && closing[1].length >= fence.length;
  });
  if (end < 0 || end !== body.length - 1) return { error: usage };
  const code = body.slice(0, end).join('\n');
  return code.trim() ? { code } : { error: usage };
}

export async function runDirectPython(request, settings, signal, context) {
  if (request.error) return { ok: false, text: request.error };
  const tools = toolSettings(settings);
  if (!tools.enabled || !tools.python) {
    return { ok: false, text: 'सेटिंग्स में टूल्स और Python चालू करके दोबारा भेजें।' };
  }
  return runTool('run_python', { code: request.code }, settings, signal, context);
}
