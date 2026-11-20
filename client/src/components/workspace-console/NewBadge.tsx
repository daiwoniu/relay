export default function NewBadge({className=''}:{className?:string}){
  return <span className={`inline-block shrink-0 rounded-sm border border-rose-400/40 bg-rose-400/10 px-1 py-0 text-[9px] font-semibold leading-3 text-rose-400 ${className}`}>NEW</span>;
}
