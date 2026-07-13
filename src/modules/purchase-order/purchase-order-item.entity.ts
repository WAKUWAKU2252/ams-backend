import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  JoinColumn,
  type Relation,
} from 'typeorm';
import { PurchaseOrder } from './purchase-order.entity';
import { GrpoLine } from '../grpo/grpo-line.entity';

@Entity('purchase_order_item')
export class PurchaseOrderItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int' })
  poLine: number;

  @Column()
  itemDescription: string;

  @Column({ type: 'int' })
  quantity: number;

  // pg ส่ง numeric กลับมาเป็น string — แปลงเป็น number ให้ frontend ใช้คำนวณได้เลย
  @Column({
    type: 'numeric',
    transformer: {
      to: (value: number) => value,
      from: (value: string) => Number(value),
    },
  })
  unitPrice: number;

  @Column({ length: 50 })
  poNumber: string;

  @ManyToOne(() => PurchaseOrder, (po) => po.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'poNumber' })
  purchaseOrder: Relation<PurchaseOrder>;

  @OneToMany(() => GrpoLine, (line) => line.poItem)
  grpoLines: Relation<GrpoLine>[];
}
