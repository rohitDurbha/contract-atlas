export type DescriptionBlock = {type:'heading'|'paragraph'|'list';text:string;items?:string[]};
const headings='Job Summary|Position Summary|Summary|Overview|About the Role|About the Position|Key Responsibilities|Responsibilities|Duties|Required Qualifications|Preferred Qualifications|Qualifications|Requirements|Required Skills|Preferred Skills|Skills|Education|Experience|Benefits|What You Will Do|What You Bring';
export function descriptionBlocks(value:string):DescriptionBlock[] {
  const text=value.replace(/\r\n?/g,'\n').replace(/(^|\n)[ \t]*([•●▪*-])[ \t]*\n+\s*/g,'$1$2 ').replace(new RegExp(`(${headings})\\s*:`, 'gi'),'\n\n$1:\n\n')
    .replace(/(Title|Location|Duration|Work Engagement|Work Schedule|Job Title|Estimated Duration):/g,'\n$1:')
    .replace(/\.([A-Z][a-z]{2,})/g,'. $1');
  const blocks:DescriptionBlock[]=[];
  for(const raw of text.split(/\n+/)) {
    const line=raw.trim();if(!line)continue;
    if(new RegExp(`^(?:${headings}):?$`,'i').test(line)){blocks.push({type:'heading',text:line.replace(/:$/,'')});continue;}
    if(/^(?:[•●▪*-]|\d+[.)])\s+/.test(line)) {
      const item=line.replace(/^(?:[•●▪*-]|\d+[.)])\s+/,'');const last=blocks.at(-1);
      if(last?.type==='list')last.items!.push(item);else blocks.push({type:'list',text:'',items:[item]});continue;
    }
    // Legacy snapshots lost HTML boundaries. Break long prose at sentence ends,
    // without summarizing, deleting, or inventing any of the source's wording.
    const sentences=Array.from(new Intl.Segmenter('en',{granularity:'sentence'}).segment(line),part=>part.segment);
    if(line.length>650 && sentences.length>3) {
      for(let i=0;i<sentences.length;i+=3)blocks.push({type:'paragraph',text:sentences.slice(i,i+3).join('').trim()});
    } else blocks.push({type:'paragraph',text:line});
  }
  return blocks;
}
