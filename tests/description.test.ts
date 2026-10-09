import {describe,it,expect} from 'vitest';
import {descriptionText} from '../server/normalize';
import {descriptionBlocks} from '../src/description';
import {SOURCES,RETIRED_SOURCE_IDS} from '../server/sources';
describe('readable source descriptions',()=>{
 it('preserves paragraph, heading and list boundaries without executable markup',()=>{
  const text=descriptionText('<h2>Responsibilities</h2><p>Build reliable pipelines.</p><ul><li>Use SQL.</li><li>Review data.</li></ul><script>bad()</script><p>Location:<br>San Jose</p>');
  const blocks=descriptionBlocks(text);
  expect(blocks).toContainEqual({type:'heading',text:'Responsibilities'});
  expect(blocks).toContainEqual({type:'list',text:'',items:['Use SQL.','Review data.']});
  expect(text).not.toContain('bad()');expect(text).not.toContain('<');expect(text).toContain('Location:\nSan Jose');
 });
 it('separates legacy section labels and keeps all the words',()=>{
  const blocks=descriptionBlocks('Title: AnalystLocation: BostonResponsibilities:Review data.Qualifications:SQL experience.');
  expect(blocks.map(b=>b.text)).toEqual(['Title: Analyst','Location: Boston','Responsibilities','Review data.','Qualifications','SQL experience.']);
 });
 it('removes only the four restricted boards from active collection',()=>{
  expect(RETIRED_SOURCE_IDS.every(id=>!SOURCES.some(s=>s.id===id))).toBe(true);
  expect(SOURCES).toHaveLength(57);expect(SOURCES.some(s=>s.id==='pnc')).toBe(true);
 });
});
