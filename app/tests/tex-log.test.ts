import { expect, test } from 'bun:test'
import { parseTexLog } from '../src/utils/texLogParser'

test('preserves file and line diagnostics from nested TeX sources', () => {
 const result=parseTexLog('/revision/chapters/bad.tex:2: Undefined control sequence.\nl.2 \\buggy\n')
 expect(result.diagnostics).toContainEqual(expect.objectContaining({type:'error',file:'/revision/chapters/bad.tex',line:2,message:'Undefined control sequence.'}))
})
