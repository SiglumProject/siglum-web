import {test,expect} from 'bun:test'
import {checkpointEntry} from '../src/services/CheckpointEntry'
const article='\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}'
test('standalone documents retain their source and path without scanning other files',async()=>{
 let reads=0
 const out=await checkpointEntry(article,'/project/src/resume.tex',async()=>{reads++;return null})
 expect(out).toEqual({source:article,path:'/project/src/resume.tex'});expect(reads).toBe(0)
})
test('an included source finds its nearby main and does not escape its mount',async()=>{
 const main='\\documentclass{book}\n\\begin{document}\n\\include{chapters/introduction}\n\\end{document}'
 const reads:string[]=[]
 const out=await checkpointEntry('An edited paragraph.','/project/src/book/chapters/introduction.tex',async path=>{
 reads.push(path);return path==='/project/src/book/main.tex'?new TextEncoder().encode(main):null
 })
 expect(out).toEqual({source:main,path:'/project/src/book/main.tex'})
 expect(reads.every(path=>path.startsWith('/project/src/'))).toBe(true)
})
test('a commented include is not mistaken for a project entry point',async()=>{
 const path='/git/chapters/ch.tex'
 const out=await checkpointEntry('body',path,async()=>new TextEncoder().encode('\\documentclass{article}\n% \\include{chapters/ch}'))
 expect(out.path).toBe(path)
})

test('nested diagram inputs resolve through the ordinary project dependency scanner', async () => {
 const root='/project/src/book'
 const files: Record<string,string>={
  [root+'/main.tex']: '\\documentclass{book}\n\\begin{document}\n\\include{chapters/one}\n\\end{document}',
  [root+'/chapters/one.tex']: '\\input{figures/diagram.tex}',
  [root+'/figures/diagram.tex']: 'diagram source',
 }
 const out=await checkpointEntry('edited diagram',root+'/figures/diagram.tex',async path=>files[path]?new TextEncoder().encode(files[path]):null)
 expect(out.path).toBe(root+'/main.tex')
 expect(out.files?.['book/figures/diagram.tex']).toBeDefined()
})

