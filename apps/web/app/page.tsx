import { redirect } from 'next/navigation';

/** The admin console is the product. Land people in it. */
export default function Home() {
  redirect('/upload');
}
